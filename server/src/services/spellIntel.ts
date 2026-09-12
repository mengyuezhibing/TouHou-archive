/**
 * 符卡情报：从 ECL 里定位 Boss 战，并给出每场符卡的难度 / 持续时间 / 弹幕特征。
 *
 * 识别依据（全部来自已验证的权威结构）：
 *   · Boss 战的生成指令带**大血量**（TH06 里 Boss 为 13000/15000，杂兵 ≤ 数百）
 *   · 每个这样的波次携带 sub 索引 → 直接定位它的行为脚本
 *   · 行为脚本的时长即符卡持续时间，rank_mask 高字节即难度覆盖
 *   · 脚本里的 opcode 0x43 / 0x45 参数即弹幕的速度 / 角度 / 角速度 / 弹种
 *
 * 与 MSG 挖掘出的符卡名的对应：两者都按游戏内出现顺序排列，
 * 前端并排呈现供人工核对，不做强行自动配对（顺序在不同版本间可能有出入）。
 */
import fs from 'node:fs';
import { db } from '../db/index.ts';
import { parseEcl } from '../formats/ecl.ts';
import { extractAllSequences, collectTransitive, type DanmakuEvent } from '../formats/danmakuScript.ts';
import { analyzeEnemyIntel } from './enemyIntel.ts';

export interface SpellIntel {
  /** 全局序号（按游戏内出现顺序：关卡升序 → 时间升序） */
  index: number;
  stage: number;
  eclFile: string;
  /** Boss 战开始时刻（秒） */
  waveTime: number;
  hp: number;
  score: number;
  /** 行为脚本索引 */
  subIndex: number;
  /** 符卡持续时间（秒） */
  durationSeconds: number;
  difficulties: string[];
  eventCount: number;
  totalBullets: number;
  spiral: boolean;
  angles: number[];
  speeds: number[];
  bulletTypes: number[];
  /** 回放所需的完整事件序列 */
  events: DanmakuEvent[];
}

const BOSS_HP_THRESHOLD = 1000;

export function buildSpellIntel(gameCode: string): { items: SpellIntel[]; notes: string[] } {
  const notes: string[] = [];
  const gid = (db.prepare('SELECT id FROM game WHERE code = ?').get(gameCode) as any)?.id;
  if (!gid) return { items: [], notes };

  const intelByStage = new Map(analyzeEnemyIntel(gameCode).map((i) => [i.stage, i]));

  const rows = db
    .prepare("SELECT filename, path FROM resource WHERE game_id = ? AND kind = 'ecl' ORDER BY filename")
    .all(gid) as Array<{ filename: string; path: string }>;

  const out: SpellIntel[] = [];

  for (const row of rows) {
    if (!row.path || !fs.existsSync(row.path)) continue;
    const m = row.filename.match(/(\d+)/);
    const stage = m ? Number(m[1]) : 0;
    const stageIntel = intelByStage.get(stage);
    if (!stageIntel) continue;

    let analysis;
    try {
      analysis = parseEcl(fs.readFileSync(row.path));
    } catch {
      continue;
    }
    const seqBySub = new Map(
      extractAllSequences(analysis, 1).map((s) => [s.subIndex, s]),
    );

    const bossWaves = stageIntel.waves
      .filter((w) => w.hp >= BOSS_HP_THRESHOLD)
      .sort((a, b) => a.frame - b.frame);

    const seen = new Set<string>();
    let noDanmaku = 0;

    for (const w of bossWaves) {
      // 镜像编队会为同一波敌机生成多条相同指令，按 关卡+时间+脚本 去重
      const key = `${stage}:${w.frame}:${w.sub}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Boss 行为脚本通常自身不含弹幕，而是通过 call 链调用弹幕子程序；
      // 递归收集整条调用链上的发射事件
      const seq = collectTransitive(analysis, w.sub) ?? seqBySub.get(w.sub);
      if (!seq || seq.events.length === 0) {
        // Boss 的行为脚本常通过「调用其他子程序」来发射弹幕，
        // 直接含 0x43/0x45 的情况反而少。调用链解析尚未接入，
        // 这里如实跳过并计数，而不是拿同关其他弹幕冒充。
        noDanmaku++;
        continue;
      }

      out.push({
        index: 0,
        stage,
        eclFile: row.filename,
        waveTime: Number((w.frame / 60).toFixed(2)),
        hp: w.hp,
        score: w.score,
        subIndex: w.sub,
        durationSeconds: seq.durationSeconds,
        difficulties: seq.difficulties,
        eventCount: seq.eventCount,
        totalBullets: seq.totalBullets,
        spiral: seq.spiral,
        angles: seq.angles,
        speeds: seq.speeds,
        bulletTypes: seq.bulletTypes,
        events: seq.events,
      });
    }

    if (noDanmaku > 0) {
      notes.push(
        `${row.filename}：${noDanmaku} 场 Boss 战的行为脚本未直接含弹幕指令` +
          `（弹幕在其调用的子程序中），调用链解析待接入`,
      );
    }
  }

  // 关卡升序 → 时间升序，与游戏内符卡出现顺序一致
  const items = out
    .sort((a, b) => a.stage - b.stage || a.waveTime - b.waveTime)
    .map((s, i) => ({ ...s, index: i + 1 }));
  return { items, notes };
}
