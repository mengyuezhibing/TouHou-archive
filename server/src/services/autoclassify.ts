import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { db, nowIso, gameIdByCode, setResourceTags } from '../db/index.ts';
import { harvestSpellCandidates } from './spellcards.ts';
import { decodeShiftJis } from '../formats/textcodec.ts';

/**
 * 从二进制中扫描 Shift-JIS 文本片段。
 * ECL 里的符卡名是裸字符串常量，没有长度前缀，只能按字节范围切分。
 */
function extractSjisStrings(buf: Buffer, minLen = 4, maxBytes = 64): string[] {
  const out: string[] = [];
  let start = -1;

  // Shift-JIS 的字节角色划分：
  //   前导字节 0x81-0x9F / 0xE0-0xFC，其后必须跟一个第二字节
  //   第二字节 0x40-0x7E / 0x80-0xFC  ← 0x80 极易被漏掉，漏掉就会把字符串切碎
  //   单字节   ASCII 0x20-0x7E / 半角片假名 0xA1-0xDF
  const isLead = (b: number) => (b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc);
  const isTrail = (b: number) => (b >= 0x40 && b <= 0x7e) || (b >= 0x80 && b <= 0xfc);
  const isSingle = (b: number) => (b >= 0x20 && b <= 0x7e) || (b >= 0xa1 && b <= 0xdf);

  const flush = (end: number) => {
    if (start < 0) return;
    const len = end - start;
    if (len >= minLen && len <= maxBytes) {
      const text = decodeShiftJis(buf.subarray(start, end));
      if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(text)) out.push(text);
    }
    start = -1;
  };

  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (isLead(b) && i + 1 < buf.length && isTrail(buf[i + 1])) {
      if (start < 0) start = i;
      i += 2;
      continue;
    }
    if (isSingle(b)) {
      if (start < 0) start = i;
      i += 1;
      continue;
    }
    flush(i);
    i += 1;
  }
  flush(buf.length);
  return out;
}

/**
 * 自动分类填充：把已索引的资源归入各研究模块。
 *
 * 与解包时的归类不同，本模块**不依赖 ANM 解析**——很多汉化版 / 重打包版的
 * ANM 结构已被改写（存外部文件路径而非内嵌贴图），若把角色聚合挂在 ANM 上，
 * 整条链路会断掉。因此改为直接依据**资源文件名规律**构建研究实体：
 *
 *   player00.png / player00.anm   → 自机
 *   face03a.png / face03b.png     → 角色 03 的立绘组
 *   stg1enm.png / stg1enm2.png    → 第 1 关敌机
 *   ecldata*.ecl                  → 弹幕模式（已由 ECL 解析产出）
 *   *.msg / msg*.dat              → 对话文本 → 符卡候选
 *
 * 编号到具体角色名的映射**不做猜测**：TH06 原版与 thcrap 重编译版的编号
 * 并不一致，硬编码会伪造数据。此处只产出结构化实体与候选名单，由人工指派。
 */

export interface AutoClassifyResult {
  characters: number;
  characterAssets: number;
  enemies: number;
  bosses: number;
  spells: number;
  dialogueLinked: number;
  warnings: string[];
}

/** 各作品的可选角色名单（供界面下拉指派，不参与自动命名） */
const ROSTER: Record<string, string[]> = {
  TH06: [
    '博丽灵梦', '雾雨魔理沙', '露米娅', '大妖精', '琪露诺', '红美铃',
    '小恶魔', '帕秋莉·诺蕾姬', '十六夜咲夜', '蕾米莉亚·斯卡雷特', '芙兰朵露·斯卡雷特',
  ],
  TH07: ['博丽灵梦', '雾雨魔理沙', '十六夜咲夜', '蕾蒂·霍瓦特洛克', '橙', '爱丽丝·玛格特罗伊德', '莉莉白', '露娜萨', '梅露兰', '莉莉卡', '魂魄妖梦', '西行寺幽幽子', '八云蓝', '八云紫'],
  TH08: ['博丽灵梦', '雾雨魔理沙', '十六夜咲夜', '魂魄妖梦', '莉格露', '米斯蒂娅', '上白泽慧音', '因幡帝', '铃仙', '八意永琳', '蓬莱山辉夜', '藤原妹红'],
  TH10: ['博丽灵梦', '雾雨魔理沙', '东风谷早苗', '秋静叶', '秋穰子', '键山雏', '河城荷取', '犬走椛', '射命丸文', '伊吹萃香', '八坂神奈子', '洩矢诹访子'],
};

function baseKeyOf(name: string): string {
  const lower = name.toLowerCase().replace(/\.(png|jpe?g|bmp|anm|wav|ogg|ecl|msg|std|txt)$/i, '');
  return lower.replace(/_a$|_b$|_c$/, '');
}

/** 角色键：player00 / face03（TH06NC 的自机文件叫 slpl00a，归一到 player） */
function characterKeyOf(name: string): { key: string; kind: 'player' | 'face' } | null {
  const b = baseKeyOf(name);
  const p = b.match(/^(player\d{2})/);
  if (p) return { key: p[1], kind: 'player' };
  const sp = b.match(/^slpl(\d{2})/);
  if (sp) return { key: `player${sp[1]}`, kind: 'player' };
  const f = b.match(/^face(\d{2})/);
  if (f) return { key: `face${f[1]}`, kind: 'face' };
  return null;
}

/** 敌机键：stg1enm / stg1enm2 / enemy */
function enemyKeyOf(name: string): { key: string; stage: number | null } | null {
  const b = baseKeyOf(name);
  const m = b.match(/^stg(\d)enm(\d?)/);
  if (m) return { key: `stg${m[1]}enm${m[2] ?? ''}`, stage: Number(m[1]) };
  if (/^enemy/.test(b)) return { key: 'enemy', stage: null };
  return null;
}

/** 角色显示名：不做编号→姓名的猜测，只给出可读的结构化名称 */
function characterName(key: string, kind: 'player' | 'face'): string {
  if (kind === 'player') {
    const n = key.replace('player', '');
    return `自机 ${n}（待指派）`;
  }
  const n = key.replace('face', '');
  return `立绘角色 ${n}（待指派）`;
}

export function autoClassify(gameCode: string): AutoClassifyResult {
  const warnings: string[] = [];
  const result: AutoClassifyResult = {
    characters: 0,
    characterAssets: 0,
    enemies: 0,
    bosses: 0,
    spells: 0,
    dialogueLinked: 0,
    warnings,
  };

  const gid = gameIdByCode(gameCode);
  if (!gid) {
    warnings.push(`作品 ${gameCode} 未登记`);
    return result;
  }

  // 只清除由本模块产出的实体（人工创建的保留）
  const AUTOCLASSIFY_MARK = `%"source":"autoclassify"%`;
  db.prepare('DELETE FROM character WHERE game_id = ? AND meta LIKE ?').run(gid, AUTOCLASSIFY_MARK);
  db.prepare('DELETE FROM enemy WHERE game_id = ? AND meta LIKE ?').run(gid, AUTOCLASSIFY_MARK);
  db.prepare('DELETE FROM boss WHERE game_id = ? AND meta LIKE ?').run(gid, AUTOCLASSIFY_MARK);

  const resources = db
    .prepare('SELECT id, code, filename, category, role FROM resource WHERE game_id = ? ORDER BY code')
    .all(gid) as Array<{ id: number; code: string; filename: string; category: string; role: string }>;

  const insertCharacter = db.prepare(`
    INSERT INTO character (game_id, name, nickname, type, description, sprite_count, animation_count, colors, source, meta)
    VALUES (?, ?, NULL, ?, ?, ?, 0, ?, ?, ?)
  `);
  const insertCharacterAsset = db.prepare('INSERT OR IGNORE INTO character_asset (character_id, resource_id, asset_type) VALUES (?, ?, ?)');
  const insertEnemy = db.prepare(`
    INSERT INTO enemy (game_id, name, type, hp, speed, description, sprite_id, meta) VALUES (?, ?, ?, 0, 0, ?, NULL, ?)
  `);
  const insertBoss = db.prepare(`
    INSERT INTO boss (game_id, character_id, name, stage, rank, description, meta) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const roster = ROSTER[gameCode] ?? [];

  /* ---------------- 角色：按 player / face 前缀分组 ---------------- */
  const charGroups = new Map<string, { kind: 'player' | 'face'; items: typeof resources }>();
  for (const r of resources) {
    const k = characterKeyOf(r.filename);
    if (!k) continue;
    const g = charGroups.get(k.key) ?? { kind: k.kind, items: [] };
    g.items.push(r);
    charGroups.set(k.key, g);
  }

  for (const [key, g] of charGroups) {
    const name = characterName(key, g.kind);
    const type = g.kind === 'player' ? 'PLAYER' : 'OTHER';
    const colors = g.items
      .map((i) => (db.prepare('SELECT dominant_color FROM asset_image WHERE resource_id = ?').get(i.id) as any)?.dominant_color)
      .filter(Boolean) as string[];

    const info = insertCharacter.run(
      gid,
      name,
      type,
      `${g.items.length} 项关联资源（依据文件名 ${key}* 自动归组）`,
      g.items.length,
      JSON.stringify([...new Set(colors)].slice(0, 6)),
      `${gameCode} / ${key}*`,
      JSON.stringify({ source: 'autoclassify', key, kind: g.kind, faceId: key.replace(/\D/g, ''), roster }),
    );
    const charId = info.lastInsertRowid as number;
    result.characters++;

    for (const item of g.items) {
      const assetType = /face/i.test(key) ? 'PORTRAIT' : 'IDLE';
      insertCharacterAsset.run(charId, item.id, assetType);
      result.characterAssets++;
    }

    // 立绘角色同时登记为 Boss 候选（编号与关卡对应关系未知，stage 留空）
    if (g.kind === 'face') {
      insertBoss.run(
        gid,
        charId,
        name,
        null,
        'BOSS',
        '由立绘文件自动登记，关卡与身份待指派',
        JSON.stringify({ source: 'autoclassify', key }),
      );
      result.bosses++;
    }
  }

  /* ---------------- 敌机：按 stg*enm* / enemy 分组 ---------------- */
  const enemyGroups = new Map<string, { stage: number | null; items: typeof resources }>();
  for (const r of resources) {
    const k = enemyKeyOf(r.filename);
    if (!k) continue;
    const g = enemyGroups.get(k.key) ?? { stage: k.stage, items: [] };
    g.items.push(r);
    enemyGroups.set(k.key, g);
  }

  for (const [key, g] of enemyGroups) {
    const name = g.stage !== null ? `第 ${g.stage} 关敌机（${key}）` : `通用敌机（${key}）`;
    insertEnemy.run(
      gid,
      name,
      'FAIRY',
      `${g.items.length} 项关联资源，关卡 ${g.stage ?? '未知'}`,
      JSON.stringify({ source: 'autoclassify', key, stage: g.stage, assetCodes: g.items.map((i) => i.code) }),
    );
    result.enemies++;
  }

  /* ---------------- 符卡：对话文本 + ECL 字符串常量 ---------------- */
  const spellNames = new Set<string>();

  // 来源 1：对话文本（部分作品的符卡名会出现在 msg 中）
  try {
    for (const c of harvestSpellCandidates(gameCode)) spellNames.add(c.name);
  } catch (e) {
    warnings.push(`对话符卡挖掘失败：${(e as Error).message}`);
  }

  // 来源 2：ECL 字符串常量 —— 红魔乡的符卡名以 Shift-JIS 存在敌机脚本里
  try {
    const ecls = db
      .prepare("SELECT code, path FROM resource WHERE game_id = ? AND (kind = 'ecl' OR category = 'script') AND path IS NOT NULL")
      .all(gid) as Array<{ code: string; path: string }>;

    for (const e of ecls) {
      if (!fs.existsSync(e.path)) continue;
      const data = fs.readFileSync(e.path);
      for (const s of extractSjisStrings(data)) {
        const cleaned = s.trim();
        if (cleaned.length < 2 || cleaned.length > 48) continue;
        // 符卡名的书写特征：含「」引号，或含「符 / 札」字
        if (!/[「」『』]|[符札]/.test(cleaned)) continue;
        spellNames.add(cleaned);
      }
    }
  } catch (e) {
    warnings.push(`ECL 字符串提取失败：${(e as Error).message}`);
  }

  for (const name of spellNames) {
    const dup = db.prepare('SELECT id FROM spell_card WHERE game_id = ? AND name = ?').get(gid, name);
    if (dup) continue;
    db.prepare(`
      INSERT INTO spell_card (game_id, boss_id, boss, name, difficulty, duration, description, evaluation, reference, source, created_time)
      VALUES (?, NULL, '', ?, 'Unknown', 0, ?, '', '', ?, ?)
    `).run(gid, name, '从解包内容自动提取，需人工确认 Boss 与难度', 'auto-extract', nowIso());
    result.spells++;
  }

  /* ---------------- 对话：按台词长度与顺序建立场景分组 ---------------- */
  try {
    const rows = db.prepare('SELECT id FROM dialogue WHERE game_id = ? AND scene IS NULL').all(gid) as Array<{ id: number }>;
    const upd = db.prepare('UPDATE dialogue SET scene = ? WHERE id = ?');
    rows.forEach((r, i) => upd.run(`场景 ${Math.floor(i / 40) + 1}`, r.id));
    result.dialogueLinked = rows.length;
  } catch (e) {
    warnings.push(`对话分组失败：${(e as Error).message}`);
  }

  /* ---------------- 给新实体打上研究标签 ---------------- */
  for (const r of resources) {
    const k = characterKeyOf(r.filename);
    if (k && k.kind === 'face') setResourceTags(r.id, ['立绘', '角色素材', '已入角色库']);
    else if (k && k.kind === 'player') setResourceTags(r.id, ['自机', '角色素材', '已入角色库']);
    else if (enemyKeyOf(r.filename)) setResourceTags(r.id, ['敌机', '已入怪物库']);
  }

  return result;
}
