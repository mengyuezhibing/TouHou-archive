import { db, nowIso, gameIdByCode } from '../db/index.ts';
import { rosterOf, identifyBySpell, wikiUrl, type CharacterKnowledge } from '../core/knowledge.ts';
import { CHARACTER_HINTS } from './classify.ts';

/**
 * 角色身份识别与关联。
 *
 * 流程：
 *   1. 用符卡名反查角色（符卡名是版本间稳定的唯一锚点）
 *   2. 按关卡顺序把「待指派」的立绘角色与识别结果配对
 *   3. 改名、建立 符卡 / 弹幕 / 动画 的关联
 *
 * 立绘编号与角色的对应关系由**关卡顺序推断**得出，不是权威数据——
 * 因为重打包版本会重排编号。每条映射都带上置信度与方法标记，便于人工核对。
 */

export interface IdentifyDetail {
  key: string;
  name: string;
  nameJp: string;
  type: string;
  stage: number | null;
  spells: number;
  patterns: number;
  animations: number;
  assets: number;
  wiki: string;
  mappingMethod: string;
}

export interface IdentifyResult {
  renamed: number;
  created: number;
  spellsLinked: number;
  patternsLinked: number;
  animationsLinked: number;
  details: IdentifyDetail[];
  warnings: string[];
}

/**
 * TH06 立绘编号 → 角色 key 的**兜底**映射。
 *
 * 仅在没有 AI 打标结果时使用。曾经把它当作权威数据，但经 WD14 交叉验证后发现
 * 整表偏移（例如第 8 号被写成 sakuya，而图像是紫发持书的帕秋莉）。
 * 现在以 buildFaceMapFromAi 的动态推导为准。
 */
export const TH06_FACE_MAP_FALLBACK: Record<number, string> = {
  0: 'reimu',
  1: 'marisa',
  3: 'rumia',
  5: 'cirno',
  6: 'meiling',
  8: 'patchouli',
  9: 'sakuya',
  10: 'remilia',
  12: 'flandre',
};

/** 把 WD14 的标签名（hakurei_reimu / izayoi_sakuya）映射回角色 key（reimu / sakuya） */
function keyFromAiTag(tag: string): string | null {
  const t = tag.toLowerCase();
  for (const key of Object.keys(CHARACTER_HINTS)) {
    // 加词边界，避免 rumia 命中 rumiko 这类前缀相同的误判
    if (new RegExp(`(^|[^a-z])${key}([^a-z]|$)`).test(t)) return key;
  }
  return null;
}

export interface FaceMapping {
  faceId: number;
  key: string;
  score: number;
  method: string;
}

/**
 * 从 WD14 打标结果推导「立绘编号 → 角色 key」。
 *
 * 相比硬编码编号表的两点优势：
 *   1. AI 判断的是**图像内容**（发色 / 服饰 / 道具），不受重打包导致的编号重排影响
 *   2. 每个判断都带分数与票数，可人工复核；硬编码表无从验证
 *
 * 只保留该作品角色表内的角色，避免把其他作品的误报（如 kisume）写进映射。
 */
export function buildFaceMapFromAi(gameCode: string, gid: number): Map<number, FaceMapping> {
  const roster = new Set(rosterOf(gameCode).map((k) => k.key));
  const rows = db
    .prepare(
      `SELECT display_name, meta FROM resource
       WHERE game_id = ? AND category = 'portrait'
         AND display_name LIKE 'face%' AND meta LIKE '%aiTags%'`,
    )
    .all(gid) as Array<{ display_name: string; meta: string }>;

  // faceId → (role key → 累计分数 / 票数)
  const votes = new Map<number, Map<string, { score: number; n: number }>>();

  for (const r of rows) {
    const m = r.display_name.match(/^face(\d+)/i);
    if (!m) continue;
    const faceId = Number(m[1]);

    let chars: Array<{ name: string; score: number }> = [];
    try {
      const meta = JSON.parse(r.meta || '{}');
      const raw = meta.aiTags?.characters;
      chars = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? []);
    } catch {
      continue;
    }
    if (!Array.isArray(chars)) continue;

    for (const c of chars) {
      const key = keyFromAiTag(c.name);
      if (!key || !roster.has(key)) continue;
      if (!votes.has(faceId)) votes.set(faceId, new Map());
      const bucket = votes.get(faceId)!;
      const cur = bucket.get(key) ?? { score: 0, n: 0 };
      cur.score += c.score;
      cur.n += 1;
      bucket.set(key, cur);
    }
  }

  const out = new Map<number, FaceMapping>();
  for (const [faceId, bucket] of votes) {
    const ranked = [...bucket.entries()].sort((a, b) => b[1].score - a[1].score);
    if (ranked.length === 0) continue;
    const [key, agg] = ranked[0];
    const avg = agg.score / agg.n;
    // 平均分过低说明模型对该立绘没有把握，宁可不映射
    if (avg < 0.6) continue;
    out.set(faceId, { faceId, key, score: Number(avg.toFixed(3)), method: `ai-tag×${agg.n}` });
  }
  return out;
}

interface CharRow {
  id: number;
  name: string;
  type: string;
  sprite_count: number;
  source: string | null;
  meta: string;
}

export function identifyCharacters(gameCode: string): IdentifyResult {
  const warnings: string[] = [];
  const details: IdentifyDetail[] = [];
  const result: IdentifyResult = {
    renamed: 0,
    created: 0,
    spellsLinked: 0,
    patternsLinked: 0,
    animationsLinked: 0,
    details,
    warnings,
  };

  const gid = gameIdByCode(gameCode);
  if (!gid) {
    warnings.push(`作品 ${gameCode} 未登记`);
    return result;
  }

  const roster = rosterOf(gameCode);
  if (!roster.length) {
    warnings.push(`暂无 ${gameCode} 的角色知识库数据，无法识别身份`);
    return result;
  }

  // 立绘编号 → 角色：优先由 AI 打标推导（看图像内容），硬编码表仅作兜底
  const aiFaceMap = buildFaceMapFromAi(gameCode, gid);
  // TH06NC 是原作重制，立绘编号与原版完全同构（face00=灵梦、face03=露米娅…），
  // 直接复用同一张兜底表；若有 AI 打标数据则 AI 优先，兜底仅在无 AI 数据时生效
  const fallbackMap: Record<number, string> =
    gameCode === 'TH06' || gameCode === 'TH06NC' ? TH06_FACE_MAP_FALLBACK : {};
  /**
   * 只有在**完全没有 AI 数据**时才用兜底表。
   * 半吊子地混合两者更危险：兜底表本身有整体偏移，
   * 一旦它在 AI 未覆盖的角色上生效，就会给同一个人配到错误立绘。
   */
  const useFallback = aiFaceMap.size === 0;
  const faceIdOf = (key: string): number | undefined => {
    for (const [id, v] of aiFaceMap) if (v.key === key) return id;
    if (useFallback) {
      for (const [id, k] of Object.entries(fallbackMap)) if (k === key) return Number(id);
    }
    return undefined;
  };

  // 立绘索引（autoClassify 建立的 "kind":"face" 记录）是配对的依据，必须保留；
  // 只清理**上一次识别**指派过的角色（带 mappingMethod 标记），
  // 否则映射修正后旧归属会残留成重复记录。
  db.prepare('UPDATE spell_card SET boss_id = NULL WHERE game_id = ?').run(gid);
  db.prepare('DELETE FROM boss WHERE game_id = ?').run(gid);
  db.prepare("DELETE FROM character WHERE game_id = ? AND meta LIKE '%mappingMethod%'").run(gid);
  if (aiFaceMap.size > 0) {
    const desc = [...aiFaceMap.values()]
      .sort((a, b) => a.faceId - b.faceId)
      .map((v) => `face${String(v.faceId).padStart(2, '0')}→${v.key}(${v.score})`)
      .join(' ');
    warnings.push(`立绘映射由 AI 打标推导：${desc}`);
  }

  /* ---------------- 1. 用符卡确定角色 ---------------- */

  const spells = db
    .prepare('SELECT id, name, boss_id FROM spell_card WHERE game_id = ? ORDER BY id')
    .all(gid) as Array<{ id: number; name: string; boss_id: number | null }>;

  const hitByKey = new Map<string, { knowledge: CharacterKnowledge; spells: number[] }>();
  for (const s of spells) {
    const hit = identifyBySpell(s.name, gameCode);
    if (!hit) continue;
    const entry = hitByKey.get(hit.character.key) ?? { knowledge: hit.character, spells: [] };
    entry.spells.push(s.id);
    hitByKey.set(hit.character.key, entry);
  }

  if (hitByKey.size === 0) {
    warnings.push('未从符卡名识别出任何角色（可能是符卡尚未提取，或该作品暂无知识库数据）');
    return result;
  }

  /* ---------------- 2. 与已有角色配对 ---------------- */

  // 清理历史重复：同名角色只保留关联素材最多的一个
  // （早期版本在找不到配对时会重复新建，此处做一次性收敛）
  const dupNames = db
    .prepare('SELECT name, COUNT(*) AS c FROM character WHERE game_id = ? GROUP BY name HAVING c > 1')
    .all(gid) as Array<{ name: string; c: number }>;
  for (const d of dupNames) {
    const rows = db
      .prepare(
        `SELECT ch.id, (SELECT COUNT(*) FROM character_asset ca WHERE ca.character_id = ch.id) AS ac
         FROM character ch WHERE ch.game_id = ? AND ch.name = ? ORDER BY ac DESC`,
      )
      .all(gid, d.name) as Array<{ id: number; ac: number }>;
    for (const r of rows.slice(1)) db.prepare('DELETE FROM character WHERE id = ?').run(r.id);
    warnings.push(`合并了 ${rows.length - 1} 个重复的「${d.name}」条目`);
  }

  // 统一复位全部立绘角色：每轮识别都从干净的「立绘角色 NN（待指派）」状态出发，
  // 避免历史轮次的命名残留与配对结果互相干扰
  const allRows = db
    .prepare('SELECT id, name, type, sprite_count, source, meta FROM character WHERE game_id = ?')
    .all(gid) as CharRow[];
  for (const c of allRows) {
    const m = JSON.parse(c.meta || '{}');
    if (m.kind === 'face' && m.faceId !== undefined && m.faceId !== null) {
      db.prepare('UPDATE character SET name = ?, nickname = NULL, type = ?, meta = ? WHERE id = ?').run(
        `立绘角色 ${String(m.faceId).padStart(2, '0')}（待指派）`,
        'OTHER',
        JSON.stringify({ source: 'autoclassify', kind: 'face', faceId: m.faceId }),
        c.id,
      );
    }
  }

  const prevIdentified: CharRow[] = [];
  for (const c of prevIdentified) {
    const m = JSON.parse(c.meta || '{}');
    if (m.faceId !== undefined && m.faceId !== null) {
      // 连同名字一起复位，否则旧的错误配对会与新一轮识别结果并存
      db.prepare('UPDATE character SET name = ?, nickname = NULL, type = ?, meta = ? WHERE id = ?').run(
        `立绘角色 ${String(m.faceId).padStart(2, '0')}（待指派）`,
        'OTHER',
        JSON.stringify({ source: 'autoclassify', kind: 'face', faceId: m.faceId }),
        c.id,
      );
    }
  }

  // 复位后可能出现同名残留（旧的错误配对刚被还原），再做一次收敛
  const recheck = db
    .prepare('SELECT name, COUNT(*) AS c FROM character WHERE game_id = ? GROUP BY name HAVING c > 1')
    .all(gid) as Array<{ name: string; c: number }>;
  for (const d of recheck) {
    const rows = db
      .prepare(
        `SELECT ch.id, (SELECT COUNT(*) FROM character_asset ca WHERE ca.character_id = ch.id) AS ac
         FROM character ch WHERE ch.game_id = ? AND ch.name = ? ORDER BY ac DESC`,
      )
      .all(gid, d.name) as Array<{ id: number; ac: number }>;
    for (const r of rows.slice(1)) db.prepare('DELETE FROM character WHERE id = ?').run(r.id);
  }

  const existing = db
    .prepare('SELECT id, name, type, sprite_count, source, meta FROM character WHERE game_id = ?')
    .all(gid) as CharRow[];

  // 待指派的立绘角色，按**原版立绘编号**索引
  const faceChars = existing.filter((c) => {
    try {
      const m = JSON.parse(c.meta || '{}');
      return m.source === 'autoclassify' && m.kind === 'face';
    } catch {
      return false;
    }
  });

  const faceByFaceId = new Map<number, CharRow>();
  for (const c of faceChars) {
    const m = JSON.parse(c.meta || '{}');
    if (m.faceId !== undefined && m.faceId !== null && m.faceId !== '') {
      faceByFaceId.set(Number(m.faceId), c);
    }
  }

  const identified = [...hitByKey.values()].sort((a, b) => (a.knowledge.stage ?? 99) - (b.knowledge.stage ?? 99));

  /** 已被符卡链路认领的角色记录，补全阶段跳过它们 */
  const handledCharIds = new Set<number>();

  const updateChar = db.prepare(`
    UPDATE character SET name = ?, nickname = ?, type = ?, description = ?, colors = ?, meta = ? WHERE id = ?
  `);

  const ensureBoss = db.prepare('SELECT id FROM boss WHERE game_id = ? AND character_id = ?');
  const insertBoss = db.prepare(`
    INSERT INTO boss (game_id, character_id, name, stage, rank, description, meta) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < identified.length; i++) {
    const { knowledge, spells: spellIds } = identified[i];
    // 按立绘编号配对：编号来自 AI 打标推导（推导失败时回退到内置表）
    const faceId = faceIdOf(knowledge.key);
    const paired = faceId !== undefined ? (faceByFaceId.get(faceId) ?? null) : null;
    const pairedByAi = paired !== null && aiFaceMap.has(faceId as number);

    // 符卡的关联链路是 符卡 → Boss → Character，因此先确保 Boss 记录存在
    let bossId = (ensureBoss.get(gid, paired?.id ?? -1) as { id: number } | undefined)?.id ?? null;
    if (!bossId && paired) {
      const bi = insertBoss.run(
        gid,
        paired.id,
        knowledge.name,
        knowledge.stage,
        knowledge.type === 'EX_BOSS' ? 'EXTRA' : 'BOSS',
        knowledge.title,
        JSON.stringify({ source: 'identified', key: knowledge.key }),
      );
      bossId = bi.lastInsertRowid as number;
    }

    for (const sid of spellIds) {
      db.prepare('UPDATE spell_card SET boss_id = ?, boss = ? WHERE id = ?').run(bossId, knowledge.name, sid);
      result.spellsLinked++;
    }

    // 统计关联的弹幕模式与动画段数
    const patternCount = (
      db.prepare('SELECT COUNT(*) AS c FROM bullet_pattern WHERE spell_id IN (SELECT id FROM spell_card WHERE boss_id = ?)').get(bossId ?? -1) as any
    ).c as number;

    const stageCode = knowledge.stage !== null ? `stg${knowledge.stage}enm` : null;
    const animCount = stageCode
      ? ((db.prepare("SELECT COUNT(*) AS c FROM resource WHERE game_id = ? AND (filename LIKE ? OR filename LIKE ?)").get(gid, `${stageCode}%`, `stg${knowledge.stage}bg%`) as any)
          .c as number)
      : 0;

    const meta = {
      source: 'identified',
      key: knowledge.key,
      nameJp: knowledge.nameJp,
      nameEn: knowledge.nameEn,
      title: knowledge.title,
      stage: knowledge.stage,
      wiki: wikiUrl(knowledge),
      faceId: paired ? JSON.parse(paired.meta || '{}').faceId : null,
      mappingMethod: paired ? (pairedByAi ? 'ai-face-map' : 'face-id-map') : 'no-portrait',
      confidence: paired ? 0.85 : 0.9,
      spellCount: spellIds.length,
    };

    if (paired) {
      handledCharIds.add(paired.id);
      updateChar.run(
        knowledge.name,
        knowledge.nameJp,
        knowledge.type,
        `${knowledge.title}${knowledge.stage !== null ? ` · 第 ${knowledge.stage} 关` : ''}｜由符卡名识别（${spellIds.length} 张符卡）`,
        JSON.stringify([]),
        JSON.stringify(meta),
        paired.id,
      );
      result.renamed++;
    } else if (db.prepare("SELECT id FROM character WHERE game_id = ? AND name = ? AND meta LIKE '%\"source\":\"identified\"%'").get(gid, knowledge.name)) {
      // 该角色已在先前运行中识别过，仅更新符卡关联，不重复新建
    } else {
      const info = db.prepare(`
        INSERT INTO character (game_id, name, nickname, type, description, sprite_count, animation_count, colors, source, meta)
        VALUES (?, ?, ?, ?, ?, 0, ?, '[]', ?, ?)
      `).run(
        gid,
        knowledge.name,
        knowledge.nameJp,
        knowledge.type,
        `${knowledge.title}｜由符卡名识别（无对应立绘）`,
        animCount,
        `${gameCode} / spell-identified`,
        JSON.stringify(meta),
      );
      result.created++;

      // Boss 表同步
      db.prepare(`
        INSERT INTO boss (game_id, character_id, name, stage, rank, description, meta) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        gid,
        info.lastInsertRowid as number,
        knowledge.name,
        knowledge.stage,
        knowledge.type === 'EX_BOSS' ? 'EXTRA' : 'BOSS',
        knowledge.title,
        JSON.stringify({ source: 'identified', key: knowledge.key }),
      );
    }

    const assetCount = paired ? (db.prepare('SELECT COUNT(*) AS c FROM character_asset WHERE character_id = ?').get(paired.id) as any).c : 0;

    result.patternsLinked += patternCount;
    result.animationsLinked += animCount;

    details.push({
      key: knowledge.key,
      name: knowledge.name,
      nameJp: knowledge.nameJp,
      type: knowledge.type,
      stage: knowledge.stage,
      spells: spellIds.length,
      patterns: patternCount,
      animations: animCount,
      assets: assetCount as number,
      wiki: wikiUrl(knowledge),
      mappingMethod: meta.mappingMethod,
    });
  }

  /* ---------------- 2.5 无符卡角色（自机等）：靠 AI 立绘映射补全 ---------------- */

  // 自机没有符卡，走不到上面的「符卡名 → 角色」链路；但它们有立绘，
  // 而 AI 能稳定认出画面是谁 —— 因此直接依据立绘归属落名。
  for (const [faceId, mapping] of aiFaceMap) {
    const row = faceByFaceId.get(faceId);
    if (!row || handledCharIds.has(row.id)) continue;
    const k = roster.find((x) => x.key === mapping.key);
    if (!k) continue;

    const meta = {
      source: 'identified',
      key: k.key,
      nameJp: k.nameJp,
      nameEn: k.nameEn,
      title: k.title,
      stage: k.stage,
      wiki: wikiUrl(k),
      faceId,
      mappingMethod: 'ai-face-map',
      confidence: mapping.score,
      spellCount: 0,
    };

    updateChar.run(
      k.name,
      k.nameJp,
      k.type,
      `${k.title}｜由 AI 立绘识别确定（该角色无符卡）`,
      JSON.stringify([]),
      JSON.stringify(meta),
      row.id,
    );
    handledCharIds.add(row.id);
    result.renamed++;

    const assetCount = (
      db.prepare('SELECT COUNT(*) AS c FROM character_asset WHERE character_id = ?').get(row.id) as any
    ).c as number;
    details.push({
      key: k.key,
      name: k.name,
      nameJp: k.nameJp,
      type: k.type,
      stage: k.stage,
      spells: 0,
      patterns: 0,
      animations: 0,
      assets: assetCount,
      wiki: wikiUrl(k),
      mappingMethod: 'ai-face-map',
    });
  }

  /* ---------------- 3. 清理占位角色 ---------------- */

  const matchedFaceIds = new Set(
    details
      .filter((d) => d.mappingMethod === 'ai-face-map' || d.mappingMethod === 'face-id-map')
      .map((d) => faceIdOf(d.key))
      .filter((id): id is number => id !== undefined),
  );

  /**
   * 同一立绘若已识别出正式角色，其余带该 faceId 的占位记录就多余了。
   *
   * 注意必须遍历**全部**角色而非只遍历 faceChars：
   * autoClassify 给自机建的占位角色 kind 是 "player" 而不是 "face"，
   * 但它们同样挂着 faceId，只看 faceChars 会漏掉、留下重名占位。
   * 同理 faceId 可能是字符串 "00"，一律用 Number 归一后再比较。
   */
  let prunedFaces = 0;
  const allChars = db.prepare('SELECT id, meta FROM character WHERE game_id = ?').all(gid) as Array<{
    id: number;
    meta: string;
  }>;

  for (const c of allChars) {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(c.meta || '{}');
    } catch {
      continue;
    }
    const raw = m.faceId;
    if (raw === undefined || raw === null || raw === '') continue;
    const faceId = Number(raw);
    if (Number.isNaN(faceId) || !matchedFaceIds.has(faceId)) continue;
    if (handledCharIds.has(c.id)) continue;
    if (m.mappingMethod) continue;
    db.prepare('DELETE FROM character_asset WHERE character_id = ?').run(c.id);
    db.prepare('DELETE FROM character WHERE id = ?').run(c.id);
    prunedFaces++;
  }

  const unmatchedFaces = faceChars
    .filter((c) => !matchedFaceIds.has(Number(JSON.parse(c.meta || '{}').faceId)))
    .map((c) => `face${String(JSON.parse(c.meta || '{}').faceId ?? '?').padStart(2, '0')}`);

  if (unmatchedFaces.length) {
    warnings.push(`未配对的立绘：${unmatchedFaces.join(', ')}（无符卡且 AI 未给出稳定判断）`);
  }
  if (prunedFaces > 0) {
    warnings.push(`已清理 ${prunedFaces} 条多余的立绘占位记录`);
  }

  db.prepare('UPDATE game SET status = ? WHERE id = ?').run('extracted', gid);

  return result;
}
