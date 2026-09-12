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
