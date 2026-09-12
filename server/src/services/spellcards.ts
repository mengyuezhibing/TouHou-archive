import { db, nowIso, gameIdByCode } from '../db/index.ts';

/**
 * 符卡库自动构建（对应设计文档第十一节与数据库文档第十节 SpellCard）。
 * 从已解包的剧情文本中提取符卡名候选：
 *   - 日文符卡的标准书写形式为「○○符『××』」或「恋符「マスタースパーク」」
 *   - 同时收录带书名号/引号的短句作为候选，交由人工确认
 */

export interface SpellCandidate {
  name: string;
  gameId: string;
  sourceLine: string;
  score: number;
  boss: string;
}

const QUOTE_RE = /[「『"]([^」』"]{2,40})[」』"]/g;
const SPELL_LIKE = /[符札]|スペルカード|スペル|spell/i;

/** 从一行文本中抽取符卡候选 */
export function extractFromLine(line: string): { name: string; score: number }[] {
  const out: { name: string; score: number }[] = [];

  // 形如 恋符「マスタースパーク」 —— 引号前带符/札字
  const fullRe = /([^\s「『"]{0,10}[符札])[「『]([^」』]{2,40})[」』]/g;
  let m: RegExpExecArray | null;
  while ((m = fullRe.exec(line)) !== null) {
    const prefix = m[1].trim();
    const inner = m[2].trim();
    out.push({ name: `${prefix}「${inner}」`, score: 0.95 });
  }

  QUOTE_RE.lastIndex = 0;
  while ((m = QUOTE_RE.exec(line)) !== null) {
    const inner = m[1].trim();
    if (inner.length < 2) continue;
    const score = SPELL_LIKE.test(inner) ? 0.8 : 0.5;
    out.push({ name: inner, score });
  }

  return out;
}

export function harvestSpellCandidates(gameCode?: string, minScore = 0.6): SpellCandidate[] {
  const base = `
    SELECT d.text AS text, g.code AS game_code
    FROM dialogue d LEFT JOIN game g ON g.id = d.game_id
  `;
  const rows = (gameCode
    ? db.prepare(`${base} WHERE g.code = ? LIMIT 20000`).all(gameCode)
    : db.prepare(`${base} LIMIT 20000`).all()) as Array<{ text: string; game_code: string }>;

  const seen = new Map<string, SpellCandidate>();
  for (const r of rows) {
    if (!r.text || !r.game_code) continue;
    for (const c of extractFromLine(r.text)) {
      if (c.score < minScore) continue;
      const key = `${r.game_code}::${c.name}`;
      const prev = seen.get(key);
      if (!prev || c.score > prev.score) {
        seen.set(key, { name: c.name, gameId: r.game_code, sourceLine: r.text.slice(0, 200), score: c.score, boss: '' });
      }
    }
  }

  return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 500);
}

/** 将候选写入符卡库（已存在的跳过） */
export function importSpellCandidates(candidates: SpellCandidate[]): { imported: number; skipped: number } {
  const exists = db.prepare('SELECT id FROM spell_card WHERE game_id = ? AND name = ?');
  const insert = db.prepare(`
    INSERT INTO spell_card (game_id, boss_id, boss, name, difficulty, duration, description, evaluation, reference, source, created_time)
    VALUES (?, NULL, ?, ?, 'Unknown', 0, ?, '', '', 'msg-harvest', ?)
  `);

  let imported = 0;
  let skipped = 0;
  for (const c of candidates) {
    const gid = gameIdByCode(c.gameId);
    if (!gid) {
      skipped++;
      continue;
    }
    if (exists.get(gid, c.name)) {
      skipped++;
      continue;
    }
    insert.run(
      gid,
      c.boss,
      c.name,
      `自动提取自剧情文本，置信度 ${c.score.toFixed(2)}。原文：${c.sourceLine.slice(0, 80)}`,
      nowIso(),
    );
    imported++;
  }
  return { imported, skipped };
}

/** 内置常见符卡参考（用于演示与快速起步） */
export function seedKnownSpells(gameCode = 'TH06') {
  const gid = gameIdByCode(gameCode);
  if (!gid) return 0;

  const known: Array<{ boss: string; name: string; type: string }> = [
    { boss: '露米娅', name: '宵暗「Dark Side of the Moon」', type: 'ring' },
    { boss: '琪露诺', name: '冰符「Icicle Fall」', type: 'fan' },
    { boss: '红美铃', name: '华符「彩光乱舞」', type: 'fan' },
    { boss: '小恶魔', name: '魔符「Ice Sign」', type: 'spiral' },
    { boss: '帕秋莉·诺蕾姬', name: '火符「Agni Shine」', type: 'ring' },
    { boss: '十六夜咲夜', name: '奇术「Misdirection」', type: 'spiral' },
    { boss: '蕾米莉亚·斯卡雷特', name: '红符「Scarlet Shoot」', type: 'fan' },
    { boss: '芙兰朵露·斯卡雷特', name: '禁忌「Lævateinn」', type: 'dense' },
  ];

  const exists = db.prepare('SELECT id FROM spell_card WHERE game_id = ? AND name = ?');
  const insert = db.prepare(`
    INSERT INTO spell_card (game_id, boss_id, boss, name, difficulty, duration, description, evaluation, reference, source, created_time)
    VALUES (?, NULL, ?, ?, 'Normal', 40, '', '', '', 'builtin', ?)
  `);

  let n = 0;
  for (const k of known) {
    if (exists.get(gid, k.name)) continue;
    insert.run(gid, k.boss, k.name, '', nowIso());
    n++;
  }
  return n;
}
