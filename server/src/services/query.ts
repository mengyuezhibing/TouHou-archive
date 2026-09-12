import {
  db,
  jsonParse,
  nowIso,
  uid,
  TAGS_SUBQUERY,
  gameIdByCode,
  resourceIdByCode,
  setResourceTags,
  addResourceTag,
  removeResourceTag,
  tagsOfResource,
} from '../db/index.ts';

/**
 * 数据查询层。
 *
 * 内部完全基于《数据库设计文档 V1.0》的表结构（resource / asset_image /
 * character_asset / animation / bullet_pattern / bullet_action / tag ...），
 * 对外则通过 SQL 别名把物理主键与业务编码互相映射，
 * 使 API 响应形状保持稳定，避免上层与界面随之改动。
 */

// ================================================================ 映射

/** resource 行的标准投影（列名即为对外字段名） */
const RESOURCE_SELECT = `
  r.id            AS rid,
  r.code          AS id,
  g.code          AS game_id,
  r.archive_id    AS archive_id,
  r.filename      AS entry_name,
  r.display_name  AS display_name,
  r.ext           AS ext,
  r.kind          AS kind,
  r.category      AS category,
  r.role          AS role,
  r.resource_type AS resource_type,
  r.size          AS size,
  r.entry_offset  AS entry_offset,
  r.path          AS cache_path,
  r.hash          AS content_hash,
  r.meta          AS meta,
  r.created_time  AS created_at,
  COALESCE(img.width, 0)  AS width,
  COALESCE(img.height, 0) AS height,
  ${TAGS_SUBQUERY}
`;

const RESOURCE_FROM = `
  FROM resource r
  LEFT JOIN game g ON g.id = r.game_id
  LEFT JOIN asset_image img ON img.resource_id = r.id
`;

function mapAsset(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    rid: row.rid,
    game_id: row.game_id,
    archive_id: row.archive_id,
    entry_name: row.entry_name,
    display_name: row.display_name,
    ext: row.ext,
    kind: row.kind,
    category: row.category,
    role: row.role,
    resource_type: row.resource_type,
    size: row.size,
    width: row.width,
    height: row.height,
    entry_offset: row.entry_offset,
    cache_path: row.cache_path,
    content_hash: row.content_hash,
    tags: jsonParse<string[]>(row.tags, []),
    meta: jsonParse<Record<string, unknown>>(row.meta, {}),
    created_at: row.created_at,
  };
}

function mapGame(row: any) {
  if (!row) return null;
  return {
    id: row.code,
    name: row.name,
    name_jp: row.name_jp,
    short_name: row.short_name,
    version: row.version,
    engine: row.engine,
    year: row.release_year,
    path: row.root_path,
    exe_path: row.exe_path,
    kind: row.kind,
    status: row.status,
    note: row.note,
    created_time: row.created_time,
    scanned_at: row.scanned_time,
    extracted_at: row.extracted_time,
  };
}

// ================================================================ 游戏

export function listGames() {
  return (db.prepare('SELECT * FROM game ORDER BY release_year ASC, code ASC').all() as any[]).map(mapGame);
}

export function getGame(code: string) {
  return mapGame(db.prepare('SELECT * FROM game WHERE code = ?').get(code));
}

export function upsertGame(g: {
  code: string;
  name: string;
  nameJp?: string;
  shortName?: string;
  version?: string;
  engine?: string;
  year?: number;
  path?: string;
  exePath?: string | null;
  kind?: string;
  note?: string;
}) {
  const now = nowIso();
  db.prepare(`
    INSERT INTO game (code, name, name_jp, short_name, version, engine, release_year, root_path, exe_path, kind, note, status, created_time, scanned_time)
    VALUES (@code, @name, @nameJp, @shortName, @version, @engine, @year, @path, @exePath, @kind, @note, 'scanned', @now, @now)
    ON CONFLICT(code) DO UPDATE SET
      name = excluded.name, name_jp = excluded.name_jp, short_name = excluded.short_name,
      version = excluded.version, engine = excluded.engine, release_year = excluded.release_year,
      root_path = excluded.root_path, exe_path = excluded.exe_path, kind = excluded.kind,
      note = excluded.note, scanned_time = excluded.scanned_time
  `).run({
    code: g.code,
    name: g.name,
    nameJp: g.nameJp ?? '',
    shortName: g.shortName ?? '',
    version: g.version ?? g.code,
    engine: g.engine ?? '',
    year: g.year ?? 0,
    path: g.path ?? '',
    exePath: g.exePath ?? null,
    kind: g.kind ?? '',
    note: g.note ?? '',
    now,
  });
  return getGame(g.code);
}

export function deleteGame(code: string) {
  db.prepare('DELETE FROM game WHERE code = ?').run(code);
}

// ================================================================ 归档

export function listArchives(gameCode?: string) {
  const project = `
    a.id, a.game_id, g.code AS game_code, a.filename AS file_name, a.file_path, a.type,
    a.size, a.hash, a.entry_count, a.layout, a.confidence, a.notes,
    a.parsed_time AS parsed_at
  `;
  const from = 'FROM archive a LEFT JOIN game g ON g.id = a.game_id';
  const rows = gameCode
    ? (db.prepare(`SELECT ${project} ${from} WHERE g.code = ? ORDER BY a.size DESC`).all(gameCode) as any[])
    : (db.prepare(`SELECT ${project} ${from} ORDER BY a.size DESC`).all() as any[]);
  return rows;
}

// ================================================================ 素材

export interface AssetQuery {
  gameId?: string;
  kind?: string;
  category?: string;
  role?: string;
  resourceType?: string;
  q?: string;
  tag?: string;
  hasPreview?: boolean;
  limit?: number;
  offset?: number;
  sort?: 'name' | 'size' | 'recent' | 'dimension';
}

export function listAssets(query: AssetQuery) {
  const where: string[] = [];
  const params: any[] = [];

  if (query.gameId) {
    where.push('g.code = ?');
    params.push(query.gameId);
  }
  if (query.kind) {
    where.push('r.kind = ?');
    params.push(query.kind);
  }
  if (query.category) {
    where.push('r.category = ?');
    params.push(query.category);
  }
  if (query.role) {
    where.push('r.role = ?');
    params.push(query.role);
  }
  if (query.resourceType) {
    where.push('r.resource_type = ?');
    params.push(query.resourceType);
  }
  if (query.q) {
    where.push('(r.filename LIKE ? OR r.display_name LIKE ? OR r.code LIKE ?)');
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  if (query.tag) {
    // 通过标签关联表精确匹配，避免 JSON 字符串 LIKE 的误匹配
    where.push('EXISTS (SELECT 1 FROM resource_tag rt JOIN tag t ON t.id = rt.tag_id WHERE rt.resource_id = r.id AND t.name = ?)');
    params.push(query.tag);
  }
  if (query.hasPreview) {
    where.push("r.path IS NOT NULL AND r.path != ''");
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql =
    query.sort === 'size'
      ? 'ORDER BY r.size DESC'
      : query.sort === 'recent'
        ? 'ORDER BY r.created_time DESC'
        : query.sort === 'dimension'
          ? 'ORDER BY (COALESCE(img.width,0) * COALESCE(img.height,0)) DESC'
          : 'ORDER BY r.code ASC';

  const limit = Math.min(query.limit ?? 60, 500);
  const offset = query.offset ?? 0;

  const total = (db.prepare(`SELECT COUNT(*) AS c ${RESOURCE_FROM} ${whereSql}`).get(...params) as any).c as number;
  const rows = db.prepare(`SELECT ${RESOURCE_SELECT} ${RESOURCE_FROM} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`).all(...params, limit, offset);

  return { total, items: (rows as any[]).map(mapAsset), limit, offset };
}

export function getAsset(code: string) {
  return mapAsset(db.prepare(`SELECT ${RESOURCE_SELECT} ${RESOURCE_FROM} WHERE r.code = ?`).get(code));
}

export function updateAsset(
  code: string,
  patch: { displayName?: string; tags?: string[]; role?: string; category?: string; note?: string; kind?: string },
) {
  const rid = resourceIdByCode(code);
  if (!rid) return null;
  const row = db.prepare('SELECT * FROM resource WHERE id = ?').get(rid) as any;
  const meta = jsonParse<Record<string, unknown>>(row.meta, {});
  if (patch.note !== undefined) meta.note = patch.note;

  db.prepare('UPDATE resource SET display_name = ?, role = ?, category = ?, kind = ?, meta = ? WHERE id = ?').run(
    patch.displayName ?? row.display_name,
    patch.role ?? row.role,
    patch.category ?? row.category,
    patch.kind ?? row.kind,
    JSON.stringify(meta),
    rid,
  );
  if (patch.tags) setResourceTags(rid, patch.tags);
  return getAsset(code);
}

export function addTag(code: string, tag: string) {
  const rid = resourceIdByCode(code);
  if (!rid) return null;
  addResourceTag(rid, tag);
  return getAsset(code);
}

export function removeTag(code: string, tag: string) {
  const rid = resourceIdByCode(code);
  if (!rid) return null;
  removeResourceTag(rid, tag);
  return getAsset(code);
}

/**
 * 查询某个 ANM 动画包拆出的全部精灵。
 * 关联依据为 meta.sourceAnm（归档内原始条目名）。
 */
export function listAnmSprites(code: string) {
  const rid = resourceIdByCode(code);
  if (!rid) return { anm: null, items: [] };
  const row = db.prepare('SELECT game_id, filename FROM resource WHERE id = ?').get(rid) as any;
  if (!row) return { anm: null, items: [] };

  const rows = db
    .prepare(
      `SELECT ${RESOURCE_SELECT} ${RESOURCE_FROM}
       WHERE r.game_id = ? AND json_extract(r.meta, '$.sourceAnm') = ? AND r.category != 'sheet'
       ORDER BY CAST(json_extract(r.meta, '$.spriteId') AS INTEGER)`,
    )
    .all(row.game_id, row.filename) as any[];

  const sheet = db
    .prepare(
      `SELECT ${RESOURCE_SELECT} ${RESOURCE_FROM}
       WHERE r.game_id = ? AND json_extract(r.meta, '$.sourceAnm') = ? AND r.category = 'sheet' LIMIT 1`,
    )
    .get(row.game_id, row.filename) as any;

  return { anm: { id: code, entryName: row.filename }, sheet: mapAsset(sheet), items: rows.map(mapAsset) };
}

export function listCategories(gameCode?: string) {
  const sql = gameCode
    ? `SELECT r.category AS category, COUNT(*) AS count FROM resource r LEFT JOIN game g ON g.id = r.game_id
       WHERE g.code = ? GROUP BY r.category ORDER BY count DESC`
    : 'SELECT category, COUNT(*) AS count FROM resource GROUP BY category ORDER BY count DESC';
  return gameCode ? db.prepare(sql).all(gameCode) : db.prepare(sql).all();
}

/** 标签清单（含使用次数），直接来自 Tag / Resource_Tag 关联表 */
export function listTags(gameCode?: string, limit = 120) {
  const sql = gameCode
    ? `SELECT t.name AS tag, COUNT(*) AS count
       FROM resource_tag rt
       JOIN tag t ON t.id = rt.tag_id
       JOIN resource r ON r.id = rt.resource_id
       JOIN game g ON g.id = r.game_id
       WHERE g.code = ?
       GROUP BY t.id ORDER BY count DESC LIMIT ?`
    : `SELECT t.name AS tag, COUNT(*) AS count
       FROM resource_tag rt JOIN tag t ON t.id = rt.tag_id
       GROUP BY t.id ORDER BY count DESC LIMIT ?`;
  return gameCode ? db.prepare(sql).all(gameCode, limit) : db.prepare(sql).all(limit);
}

export function listTagsGrouped() {
  return db.prepare('SELECT id, name, category, color FROM tag ORDER BY category, name').all();
}

// ================================================================ 角色 / 怪物 / Boss

function mapCharacter(row: any) {
  if (!row) return null;
  return {
    ...row,
    id: row.code ?? row.id,
    game_id: row.game_code ?? row.game_id,
    colors: jsonParse<string[]>(row.colors, []),
    tags: jsonParse<string[]>(row.tags ?? '[]', []),
    meta: jsonParse<Record<string, unknown>>(row.meta, {}),
  };
}

export function listCharacters(gameCode?: string) {
  const sql = `
    SELECT c.*, g.code AS game_code,
           (SELECT COALESCE(json_group_array(t.name), '[]')
            FROM character_tag ct JOIN tag t ON t.id = ct.tag_id WHERE ct.character_id = c.id) AS tags
    FROM character c LEFT JOIN game g ON g.id = c.game_id
  `;
  const rows = gameCode
    ? (db.prepare(`${sql} WHERE g.code = ? ORDER BY c.sprite_count DESC`).all(gameCode) as any[])
    : (db.prepare(`${sql} ORDER BY c.sprite_count DESC`).all() as any[]);
  return rows.map(mapCharacter);
}

export function listEnemies(gameCode?: string) {
  const sql = 'SELECT e.*, g.code AS game_code FROM enemy e LEFT JOIN game g ON g.id = e.game_id';
  const rows = gameCode
    ? (db.prepare(`${sql} WHERE g.code = ? ORDER BY e.type, e.name`).all(gameCode) as any[])
    : (db.prepare(`${sql} ORDER BY e.type, e.name`).all() as any[]);
  return rows.map((r) => ({ ...r, game_id: r.game_code ?? r.game_id, meta: jsonParse(r.meta, {}) }));
}

export function listBosses(gameCode?: string) {
  const sql = `
    SELECT b.*, g.code AS game_code,
           (SELECT COUNT(*) FROM spell_card s WHERE s.boss_id = b.id) AS spell_count
    FROM boss b LEFT JOIN game g ON g.id = b.game_id
  `;
  const rows = gameCode
    ? (db.prepare(`${sql} WHERE g.code = ? ORDER BY b.stage`).all(gameCode) as any[])
    : (db.prepare(`${sql} ORDER BY b.stage`).all() as any[]);
  return rows.map((r) => ({ ...r, game_id: r.game_code ?? r.game_id, meta: jsonParse(r.meta, {}) }));
}

/** 角色的素材（通过 Character_Asset 关联表） */
export function getCharacterAssets(characterCodeOrId: string, limit = 200) {
  const numeric = Number(characterCodeOrId);
  const ch = db.prepare('SELECT * FROM character WHERE id = ?').get(Number.isFinite(numeric) ? numeric : -1) as any;

  if (!ch) return { character: null, items: [] };

  const rows = db
    .prepare(
      `SELECT ${RESOURCE_SELECT}, ca.asset_type
       ${RESOURCE_FROM}
       JOIN character_asset ca ON ca.resource_id = r.id
       WHERE ca.character_id = ? ORDER BY r.code LIMIT ?`,
    )
    .all(ch.id, limit) as any[];

  // 若关联表尚未建立，退化为按来源 ANM 匹配，保证界面始终有内容
  if (rows.length === 0) {
    const anmName = String(ch.source ?? '').split('/').pop()?.trim() ?? '';
    const fallback = db
      .prepare(
        `SELECT ${RESOURCE_SELECT} ${RESOURCE_FROM}
         WHERE r.game_id = ? AND (json_extract(r.meta,'$.sourceAnm') = ? OR r.filename LIKE ?)
         ORDER BY r.code LIMIT ?`,
      )
      .all(ch.game_id, anmName, `%${anmName.replace(/\.[^.]+$/, '')}%`, limit) as any[];
    return {
      character: mapCharacter({ ...ch, game_code: null }),
      items: fallback.map(mapAsset),
      linked: false,
    };
  }

  return {
    character: mapCharacter({ ...ch, game_code: null }),
    items: rows.map((r) => ({ ...mapAsset(r), asset_type: r.asset_type })),
    linked: true,
  };
}

// ================================================================ 动画

export function listAnimations(resourceCode?: string) {
  const sql = `
    SELECT a.*, r.code AS resource_code, r.filename AS resource_name
    FROM animation a LEFT JOIN resource r ON r.id = a.resource_id
  `;
  const rows = resourceCode
    ? (db.prepare(`${sql} WHERE r.code = ? ORDER BY a.name`).all(resourceCode) as any[])
    : (db.prepare(`${sql} ORDER BY a.id LIMIT 500`).all() as any[]);
  return rows.map((r) => ({ ...r, meta: jsonParse(r.meta, {}) }));
}

/** 动画及其帧序列（帧内携带对应精灵编码，供界面直接播放） */
export function getAnimation(animationId: number) {
  const anim = db.prepare('SELECT * FROM animation WHERE id = ?').get(animationId) as any;
  if (!anim) return null;
  const frames = db
    .prepare(
      `SELECT af.*, r.code AS image_code, r.path AS image_path
       FROM animation_frame af LEFT JOIN resource r ON r.id = af.image_id
       WHERE af.animation_id = ? ORDER BY af.frame_index`,
    )
    .all(animationId) as any[];
  return { ...anim, meta: jsonParse(anim.meta, {}), frames };
}

// ================================================================ 弹幕模式 / 动作时间轴

function mapPattern(row: any) {
  if (!row) return null;
  return {
    ...row,
    id: row.code ?? row.id,
    game_id: row.game_code ?? row.game_id,
    source_asset: row.source_code ?? null,
    params: jsonParse<Record<string, unknown>>(row.params, {}),
    tags: jsonParse<string[]>(row.tags ?? '[]', []),
  };
}

export function listPatterns(gameCode?: string, type?: string) {
  const where: string[] = [];
  const params: any[] = [];
  if (gameCode) {
    where.push('g.code = ?');
    params.push(gameCode);
  }
  if (type) {
    where.push('bp.type = ?');
    params.push(type);
  }
  const sql = `
    SELECT bp.*, bp.code AS id, g.code AS game_code, r.code AS source_code,
           (SELECT COUNT(*) FROM bullet_action ba WHERE ba.pattern_id = bp.id) AS action_count
    FROM bullet_pattern bp
    LEFT JOIN game g ON g.id = bp.game_id
    LEFT JOIN resource r ON r.id = bp.resource_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY bp.updated_time DESC LIMIT 300
  `;
  return (db.prepare(sql).all(...params) as any[]).map(mapPattern);
}

export function getPattern(codeOrId: string) {
  // 注意：SELECT 中把 code 别名为 id 供界面使用，因此子表查询必须用 rid（物理主键）
  const row = db
    .prepare(
      `SELECT bp.*, bp.id AS rid, bp.code AS id, g.code AS game_code, r.code AS source_code
       FROM bullet_pattern bp
       LEFT JOIN game g ON g.id = bp.game_id
       LEFT JOIN resource r ON r.id = bp.resource_id
       WHERE bp.code = ? OR bp.id = ? LIMIT 1`,
    )
    .get(codeOrId, Number(codeOrId) || -1) as any;
  if (!row) return null;
  const actions = db.prepare('SELECT * FROM bullet_action WHERE pattern_id = ? ORDER BY time').all(row.rid) as any[];
  return { ...mapPattern(row), actions: actions.map((a) => ({ ...a, parameter: jsonParse(a.parameter, {}) })) };
}

export interface PatternActionInput {
  time: number;
  action_type: string;
  parameter?: Record<string, unknown>;
}

export function savePattern(p: {
  id?: string;
  gameId?: string;
  name: string;
  sourceAsset?: string;
  type: string;
  params: Record<string, unknown>;
  origin?: string;
  tags?: string[];
  note?: string;
  duration?: number;
  difficulty?: string;
  spellId?: number;
  actions?: PatternActionInput[];
}) {
  const now = nowIso();
  const code = p.id && p.id.startsWith('BP_') ? p.id : p.id && /^[A-Z0-9_]+$/.test(p.id) ? p.id : `BP_${uid('').toUpperCase()}`;
  const gid = p.gameId ? gameIdByCode(p.gameId) : null;
  const rid = p.sourceAsset ? resourceIdByCode(p.sourceAsset) : null;

  const existing = db.prepare('SELECT id FROM bullet_pattern WHERE code = ?').get(code) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE bullet_pattern SET name = ?, type = ?, params = ?, origin = ?, tags = ?, note = ?,
        duration = ?, difficulty = ?, updated_time = ? WHERE id = ?
    `).run(
      p.name,
      p.type,
      JSON.stringify(p.params),
      p.origin ?? 'designed',
      JSON.stringify(p.tags ?? []),
      p.note ?? '',
      p.duration ?? 0,
      p.difficulty ?? '',
      now,
      existing.id,
    );
    if (p.actions) replacePatternActions(existing.id, p.actions);
  } else {
    const info = db.prepare(`
      INSERT INTO bullet_pattern (code, game_id, spell_id, resource_id, name, type, duration, difficulty, params, origin, tags, note, created_time, updated_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      code,
      gid,
      p.spellId ?? null,
      rid,
      p.name,
      p.type,
      p.duration ?? 0,
      p.difficulty ?? '',
      JSON.stringify(p.params),
      p.origin ?? 'designed',
      JSON.stringify(p.tags ?? []),
      p.note ?? '',
      now,
      now,
    );
    if (p.actions) replacePatternActions(info.lastInsertRowid as number, p.actions);
  }
  return getPattern(code);
}

/** 覆盖式写入弹幕动作时间轴（文档第 12 节 Bullet_Action） */
export function replacePatternActions(patternId: number, actions: PatternActionInput[]) {
  db.prepare('DELETE FROM bullet_action WHERE pattern_id = ?').run(patternId);
  const stmt = db.prepare('INSERT INTO bullet_action (pattern_id, time, action_type, parameter) VALUES (?, ?, ?, ?)');
  for (const a of actions) {
    stmt.run(patternId, a.time ?? 0, a.action_type, JSON.stringify(a.parameter ?? {}));
  }
}

export function listPatternActions(codeOrId: string) {
  const row = db.prepare('SELECT id FROM bullet_pattern WHERE code = ? OR id = ? LIMIT 1').get(codeOrId, Number(codeOrId) || -1) as any;
  if (!row) return [];
  return (db.prepare('SELECT * FROM bullet_action WHERE pattern_id = ? ORDER BY time').all(row.id) as any[]).map((a) => ({
    ...a,
    parameter: jsonParse(a.parameter, {}),
  }));
}

/** 覆盖写入动作时间轴并返回更新后的弹幕模式 */
export function savePatternActions(codeOrId: string, actions: PatternActionInput[]) {
  const row = db.prepare('SELECT id FROM bullet_pattern WHERE code = ? OR id = ? LIMIT 1').get(codeOrId, Number(codeOrId) || -1) as any;
  if (!row) return null;
  replacePatternActions(row.id, actions);
  db.prepare('UPDATE bullet_pattern SET updated_time = ? WHERE id = ?').run(nowIso(), row.id);
  return getPattern(codeOrId);
}

export function deletePattern(code: string) {
  db.prepare('DELETE FROM bullet_pattern WHERE code = ? OR id = ?').run(code, Number(code) || -1);
}

// ================================================================ 符卡

export function listSpells(gameCode?: string) {
  // bullet_pattern.spell_id 建立「符卡 → 弹幕模式」层级，替代旧的 pattern_json 内嵌字段
  const sql = `
    SELECT s.*, g.code AS game_code,
           (SELECT COALESCE(json_group_array(bp.code), '[]')
            FROM bullet_pattern bp WHERE bp.spell_id = s.id) AS pattern_codes
    FROM spell_card s LEFT JOIN game g ON g.id = s.game_id
  `;
  const rows = gameCode
    ? (db.prepare(`${sql} WHERE g.code = ? ORDER BY s.boss, s.difficulty`).all(gameCode) as any[])
    : (db.prepare(`${sql} ORDER BY s.boss, s.difficulty`).all() as any[]);
  return rows.map((r) => ({
    ...r,
    game_id: r.game_code ?? r.game_id,
    pattern_json: { linkedPatterns: jsonParse<string[]>(r.pattern_codes, []) },
  }));
}

export function saveSpell(s: {
  id?: string;
  gameId?: string;
  boss?: string;
  bossId?: number;
  name: string;
  difficulty?: string;
  duration?: number;
  description?: string;
  patternType?: string;
  patternJson?: Record<string, unknown>;
  evaluation?: string;
  reference?: string;
  source?: string;
}) {
  const gid = s.gameId ? gameIdByCode(s.gameId) : null;
  const numericId = Number(s.id);

  if (s.id && Number.isFinite(numericId) && numericId > 0 && db.prepare('SELECT id FROM spell_card WHERE id = ?').get(numericId)) {
    db.prepare(`
      UPDATE spell_card SET boss_id = ?, boss = ?, name = ?, difficulty = ?, duration = ?,
        description = ?, evaluation = ?, reference = ? WHERE id = ?
    `).run(s.bossId ?? null, s.boss ?? '', s.name, s.difficulty ?? 'Normal', s.duration ?? 0, s.description ?? '', s.evaluation ?? '', s.reference ?? '', numericId);
    return db.prepare('SELECT * FROM spell_card WHERE id = ?').get(numericId);
  }

  const info = db.prepare(`
    INSERT INTO spell_card (game_id, boss_id, boss, name, difficulty, duration, description, evaluation, reference, source, created_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    gid,
    s.bossId ?? null,
    s.boss ?? '',
    s.name,
    s.difficulty ?? 'Normal',
    s.duration ?? 0,
    s.description ?? '',
    s.evaluation ?? '',
    s.reference ?? '',
    s.source ?? 'manual',
    nowIso(),
  );
  return db.prepare('SELECT * FROM spell_card WHERE id = ?').get(info.lastInsertRowid as number);
}

export function deleteSpell(id: string) {
  db.prepare('DELETE FROM spell_card WHERE id = ?').run(Number(id) || -1);
}

// ================================================================ 音乐

export function listBgm(gameCode?: string) {
  const sql = `
    SELECT m.id, m.game_id, g.code AS game_code, m.index_num, m.title, m.filename AS file_name,
           m.codec, m.size, m.path AS cache_path, m.boss, m.stage AS scene, m.meta
    FROM music m LEFT JOIN game g ON g.id = m.game_id
  `;
  const rows = gameCode
    ? (db.prepare(`${sql} WHERE g.code = ? ORDER BY m.index_num`).all(gameCode) as any[])
    : (db.prepare(`${sql} ORDER BY m.game_id, m.index_num`).all() as any[]);
  return rows.map((r) => ({ ...r, game_id: r.game_code ?? r.game_id, meta: jsonParse(r.meta, {}) }));
}

export function updateBgm(id: string, patch: { boss?: string; scene?: string; title?: string }) {
  const row = db.prepare('SELECT * FROM music WHERE id = ?').get(Number(id) || -1) as any;
  if (!row) return null;
  db.prepare('UPDATE music SET boss = ?, stage = ?, title = ? WHERE id = ?').run(
    patch.boss ?? row.boss,
    patch.scene ?? row.stage,
    patch.title ?? row.title,
    row.id,
  );
  return db.prepare('SELECT * FROM music WHERE id = ?').get(row.id);
}

// ================================================================ 文本

export function searchMsg(q: string, gameCode?: string, limit = 200) {
  const where: string[] = ['d.text LIKE ?'];
  const params: any[] = [`%${q}%`];
  if (gameCode) {
    where.push('g.code = ?');
    params.push(gameCode);
  }
  const rows = db
    .prepare(
      `SELECT d.id, g.code AS game_code, r.code AS asset_id, d.time, d.text, d.encoding, d.speaker, d.scene
       FROM dialogue d
       LEFT JOIN game g ON g.id = d.game_id
       LEFT JOIN resource r ON r.id = d.resource_id
       WHERE ${where.join(' AND ')} ORDER BY g.code, d.id LIMIT ?`,
    )
    .all(...params, limit) as any[];
  return rows.map((r) => ({ ...r, game_id: r.game_code ?? '' }));
}

export function listMsg(gameCode: string, assetCode?: string, limit = 500) {
  if (assetCode) {
    const rid = resourceIdByCode(assetCode);
    return db.prepare('SELECT * FROM dialogue WHERE resource_id = ? ORDER BY id LIMIT ?').all(rid ?? -1, limit);
  }
  const gid = gameIdByCode(gameCode);
  return db.prepare('SELECT * FROM dialogue WHERE game_id = ? ORDER BY id LIMIT ?').all(gid ?? -1, limit);
}

// ================================================================ 创作辅助工程

export function listDesigns(type?: string) {
  const rows = (type
    ? db.prepare('SELECT * FROM custom_design WHERE type = ? ORDER BY updated_time DESC').all(type)
    : db.prepare('SELECT * FROM custom_design ORDER BY updated_time DESC').all()) as any[];
  return rows.map((r) => ({
    id: r.code ?? String(r.id),
    rid: r.id,
    kind: r.type,
    name: r.name,
    data: jsonParse<Record<string, unknown>>(r.json, {}),
    created_at: r.created_time,
    updated_at: r.updated_time,
  }));
}

export function getDesign(id: string) {
  const r = db.prepare('SELECT * FROM custom_design WHERE code = ? OR id = ? LIMIT 1').get(id, Number(id) || -1) as any;
  if (!r) return null;
  return {
    id: r.code ?? String(r.id),
    rid: r.id,
    kind: r.type,
    name: r.name,
    data: jsonParse<Record<string, unknown>>(r.json, {}),
    created_at: r.created_time,
    updated_at: r.updated_time,
  };
}

export function saveDesign(d: { id?: string; kind: string; name: string; data: Record<string, unknown> }) {
  const now = nowIso();
  const code = d.id && d.id.length > 0 ? d.id : `DSN_${uid('').toUpperCase()}`;
  const existing = db.prepare('SELECT id FROM custom_design WHERE code = ?').get(code) as { id: number } | undefined;
  if (existing) {
    db.prepare('UPDATE custom_design SET name = ?, type = ?, json = ?, updated_time = ? WHERE id = ?').run(
      d.name,
      d.kind,
      JSON.stringify(d.data),
      now,
      existing.id,
    );
  } else {
    db.prepare('INSERT INTO custom_design (code, type, name, json, created_time, updated_time) VALUES (?, ?, ?, ?, ?, ?)').run(
      code,
      d.kind,
      d.name,
      JSON.stringify(d.data),
      now,
      now,
    );
  }
  return getDesign(code);
}

export function deleteDesign(id: string) {
  db.prepare('DELETE FROM custom_design WHERE code = ? OR id = ?').run(id, Number(id) || -1);
}

// ================================================================ 笔记

export function listNotes(targetType?: string, targetCode?: string) {
  const where: string[] = [];
  const params: any[] = [];
  if (targetType) {
    where.push('target_type = ?');
    params.push(targetType);
  }
  if (targetCode) {
    where.push('target_code = ?');
    params.push(targetCode);
  }
  const rows = db
    .prepare(`SELECT * FROM note ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_time DESC LIMIT 200`)
    .all(...params) as any[];
  return rows.map((r) => ({
    id: String(r.id),
    target_type: r.target_type,
    target_id: r.target_code ?? r.target_id,
    title: r.title,
    body: r.content,
    created_at: r.created_time,
    updated_at: r.updated_time,
  }));
}

export function saveNote(n: { id?: string; targetType: string; targetId: string; title: string; body: string }) {
  const now = nowIso();
  const existed = n.id ? (db.prepare('SELECT id FROM note WHERE id = ?').get(Number(n.id) || -1) as any) : null;
  if (existed) {
    db.prepare('UPDATE note SET title = ?, content = ?, updated_time = ? WHERE id = ?').run(n.title, n.body, now, existed.id);
    return db.prepare('SELECT * FROM note WHERE id = ?').get(existed.id);
  }
  const info = db.prepare(`
    INSERT INTO note (target_type, target_id, target_code, title, content, created_time, updated_time)
    VALUES (?, NULL, ?, ?, ?, ?, ?)
  `).run(n.targetType, n.targetId, n.title, n.body, now, now);
  return db.prepare('SELECT * FROM note WHERE id = ?').get(info.lastInsertRowid as number);
}

export function deleteNote(id: string) {
  db.prepare('DELETE FROM note WHERE id = ?').run(Number(id) || -1);
}

// ================================================================ 仪表盘

export function getDashboard() {
  const one = (sql: string) => (db.prepare(sql).get() as any).c as number;

  const counts = {
    games: one('SELECT COUNT(*) AS c FROM game'),
    archives: one('SELECT COUNT(*) AS c FROM archive'),
    assets: one('SELECT COUNT(*) AS c FROM resource'),
    sprites: one("SELECT COUNT(*) AS c FROM resource WHERE resource_type = 'IMAGE'"),
    sheets: one("SELECT COUNT(*) AS c FROM resource WHERE category = 'sheet'"),
    animations: one('SELECT COUNT(*) AS c FROM animation'),
    animationFrames: one('SELECT COUNT(*) AS c FROM animation_frame'),
    patterns: one('SELECT COUNT(*) AS c FROM bullet_pattern'),
    patternActions: one('SELECT COUNT(*) AS c FROM bullet_action'),
    spells: one('SELECT COUNT(*) AS c FROM spell_card'),
    bosses: one('SELECT COUNT(*) AS c FROM boss'),
    enemies: one('SELECT COUNT(*) AS c FROM enemy'),
    bgm: one('SELECT COUNT(*) AS c FROM music'),
    msgLines: one('SELECT COUNT(*) AS c FROM dialogue'),
    characters: one('SELECT COUNT(*) AS c FROM character'),
    characterAssets: one('SELECT COUNT(*) AS c FROM character_asset'),
    tags: one('SELECT COUNT(*) AS c FROM tag'),
    totalSize: (db.prepare('SELECT COALESCE(SUM(size), 0) AS c FROM resource').get() as any).c as number,
  };

  const byCategory = db.prepare('SELECT category, COUNT(*) AS count FROM resource GROUP BY category ORDER BY count DESC').all();

  const byGame = db.prepare(`
    SELECT g.code AS id, g.name, g.release_year AS year, g.status, g.root_path AS path,
           (SELECT COUNT(*) FROM resource r WHERE r.game_id = g.id) AS asset_count,
           (SELECT COUNT(*) FROM music m WHERE m.game_id = g.id) AS bgm_count
    FROM game g ORDER BY g.release_year
  `).all();

  return { counts, byCategory, byGame };
}
