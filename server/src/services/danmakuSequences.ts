/**
 * 弹幕序列服务：把 ECL 里的弹幕脚本整理成可供前端回放的数据。
 *
 * 与 services/danmaku.ts 的分工：
 *   · danmaku.ts —— 参数化模拟引擎（用户手调参数，看形态）
 *   · 本模块   —— 从 ECL 还原真实弹幕（看作品里实际是怎么打的）
 */
import fs from 'node:fs';
import { db } from '../db/index.ts';
import { parseEcl } from '../formats/ecl.ts';
import { extractAllSequences, type DanmakuSequence } from '../formats/danmakuScript.ts';
import { analyzeEnemyIntel } from './enemyIntel.ts';

export interface StageSequences {
  stage: number;
  eclFile: string;
  /** 该关包含弹幕序列最多的子程序排在最前 */
  sequences: DanmakuSequence[];
  /** 全部序列的汇总 */
  totalEvents: number;
  totalBullets: number;
  spiralCount: number;
}

/**
 * 关卡弹幕场：把该关**全部子程序**的发射事件合并到一条时间线上，
 * 并给每次发射分配一个真实的敌机坐标作为发射源。
 *
 * 为什么这样做：
 *   子程序之间是各自独立的（帧从各自起点算），而主时间线里的敌机生成指令
 *   与子程序索引之间的对应关系缺少权威结构文档，无法精确配对。
 *   但"哪些位置会出现敌机"是能从主时间线可靠提取的（f32 x/y 语义已由
 *   边界自洽性验证）。于是按顺序把发射事件挂到这些真实坐标上，
 *   得到的弹幕场在**位置分布与密度**上接近游戏内实际观感。
 *
 * 与单序列回放的分工：
 *   · 单序列  —— 看某个行为脚本内部的编排（节奏、层数、螺旋）
 *   · 弹幕场  —— 看整关的弹幕形态（覆盖范围、密集区域、组合效果）
 */
export interface FieldEvent {
  /** 挂到该发射源 */
  originX: number;
  originY: number;
  /** 相对帧（合并后以 0 为起点） */
  frame: number;
  count: number;
  speed: number;
  angle: number;
  spin: number;
  bulletType: number;
  /** 来自哪个子程序，便于回溯 */
  subIndex: number;
}

export interface StageField {
  stage: number;
  eclFile: string;
  events: FieldEvent[];
  /** 去重后的发射源坐标 */
  sources: Array<{ x: number; y: number }>;
  totalEvents: number;
  totalBullets: number;
  seqCount: number;
  durationFrames: number;
  durationSeconds: number;
}

/** 收集某部作品全部关卡的弹幕序列 */
export function collectSequences(gameCode: string, minEvents = 2): StageSequences[] {
  const gid = (db.prepare('SELECT id FROM game WHERE code = ?').get(gameCode) as any)?.id;
  if (!gid) return [];

  const rows = db
    .prepare("SELECT filename, path FROM resource WHERE game_id = ? AND kind = 'ecl' ORDER BY filename")
    .all(gid) as Array<{ filename: string; path: string }>;

  const out: StageSequences[] = [];

  for (const row of rows) {
    if (!row.path || !fs.existsSync(row.path)) continue;
    let sequences: DanmakuSequence[] = [];
    try {
      sequences = extractAllSequences(parseEcl(fs.readFileSync(row.path)), minEvents);
    } catch {
      continue;
    }
    if (sequences.length === 0) continue;

    const m = row.filename.match(/(\d+)/);
    out.push({
      stage: m ? Number(m[1]) : 0,
      eclFile: row.filename,
      sequences,
      totalEvents: sequences.reduce((a, s) => a + s.eventCount, 0),
      totalBullets: sequences.reduce((a, s) => a + s.totalBullets, 0),
      spiralCount: sequences.filter((s) => s.spiral).length,
    });
  }

  return out.sort((a, b) => a.stage - b.stage);
}

/**
 * 把波次坐标收敛成可用的发射源。
 *
 * 主时间线里的 y 是画面**上方外侧**（-32，敌机尚未入场），直接拿来当发射点
 * 会让所有子弹从屏幕外出现、看不到起手动作。这里保留真实的 x（横向编队是可靠信息），
 * y 则按来源顺序分层到屏幕内，使不同敌机占据不同高度、接近实际编队观感。
 */
function dedupeSources(waves: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  if (!waves.length) return [{ x: 192, y: 72 }];
  const seen = new Set<number>();
  const out: Array<{ x: number; y: number }> = [];
  for (const w of waves) {
    // 按 12px 分桶去重：同一编队的相邻敌机位置会收敛成一个发射源
    const key = Math.round(w.x / 12);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      x: Math.max(24, Math.min(360, w.x)),
      y: 60 + (out.length % 4) * 28,
    });
  }
  return out.slice(0, 40);
}

/**
 * 构建关卡弹幕场：该关全部子程序的发射事件合并到一条时间线上。
 *
 * 各子程序按序错开起始帧 —— 子程序的帧是相对各自起点的，把它们全部叠在
 * 0 帧会让所有弹幕同时炸开，既不真实也看不出结构。错开后能看到
 * 「前一批弹幕还在飞、后一批已经出手」的叠加形态，这才是游戏里的观感。
 */
export function buildStageFields(gameCode: string): StageField[] {
  const gid = (db.prepare('SELECT id FROM game WHERE code = ?').get(gameCode) as any)?.id;
  if (!gid) return [];

  const intelByStage = new Map(analyzeEnemyIntel(gameCode).map((i) => [i.stage, i]));

  const rows = db
    .prepare("SELECT filename, path FROM resource WHERE game_id = ? AND kind = 'ecl' ORDER BY filename")
    .all(gid) as Array<{ filename: string; path: string }>;

  const out: StageField[] = [];

  for (const row of rows) {
    if (!row.path || !fs.existsSync(row.path)) continue;
    let seqs: DanmakuSequence[] = [];
    try {
      // 门槛降到 1，让只有单次发射的敌机脚本也能进弹幕场
      seqs = extractAllSequences(parseEcl(fs.readFileSync(row.path)), 1);
    } catch {
      continue;
    }
    if (!seqs.length) continue;

    const m = row.filename.match(/(\d+)/);
    const stage = m ? Number(m[1]) : 0;
    const sources = dedupeSources(intelByStage.get(stage)?.waves ?? []);

    const events: FieldEvent[] = [];
    let maxFrame = 0;
    seqs.forEach((seq, si) => {
      const offset = si * 24;
      for (const e of seq.events) {
        const src = sources[(e.frame + si) % sources.length] ?? { x: 192, y: 72 };
        const f = e.frame + offset;
        events.push({
          originX: src.x,
          originY: src.y,
          frame: f,
          count: e.count,
          speed: e.speed,
          angle: e.angle,
          spin: e.spin,
          bulletType: e.bulletType,
          subIndex: seq.subIndex,
        });
        if (f > maxFrame) maxFrame = f;
      }
    });
    events.sort((a, b) => a.frame - b.frame);

    out.push({
      stage,
      eclFile: row.filename,
      events,
      sources,
      totalEvents: events.length,
      totalBullets: events.reduce((a, e) => a + e.count, 0),
      seqCount: seqs.length,
      durationFrames: maxFrame,
      durationSeconds: Number((maxFrame / 60).toFixed(2)),
    });
  }

  return out.sort((a, b) => a.stage - b.stage);
}
