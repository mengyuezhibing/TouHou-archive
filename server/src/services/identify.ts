import { db, nowIso, gameIdByCode } from '../db/index.ts';
import { rosterOf, identifyBySpell, wikiUrl, type CharacterKnowledge } from '../core/knowledge.ts';

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
 * TH06 原版立绘编号 → 角色 key。
 *
 * 依据游戏内角色表顺序，**已用主色分析验证**：
 *   face00 主色 黑/红/白 → 博丽灵梦（红白巫女）
 *   face01 主色 黑/白    → 雾雨魔理沙（黑白魔法使）
 *
 * 注意编号里夹着自机（00/01）与中 Boss（03 大妖精、06 小恶魔），
 * 它们没有符卡，因此不能按「关卡顺序」与识别结果配对——这正是之前的错误来源。
 */
const TH06_FACE_MAP: Record<number, string> = {
  0: 'reimu',
  1: 'marisa',
  2: 'rumia',
  3: 'daiyousei',
  4: 'cirno',
  5: 'meiling',
  6: 'koakuma',
  7: 'patchouli',
  8: 'sakuya',
  9: 'remilia',
  10: 'flandre',
};

function faceIdOfKey(key: string): number | undefined {
  for (const [id, k] of Object.entries(TH06_FACE_MAP)) if (k === key) return Number(id);
  return undefined;
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

  const updateChar = db.prepare(`
    UPDATE character SET name = ?, nickname = ?, type = ?, description = ?, colors = ?, meta = ? WHERE id = ?
  `);

  const ensureBoss = db.prepare('SELECT id FROM boss WHERE game_id = ? AND character_id = ?');
  const insertBoss = db.prepare(`
    INSERT INTO boss (game_id, character_id, name, stage, rank, description, meta) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < identified.length; i++) {
    const { knowledge, spells: spellIds } = identified[i];
    // 按原版立绘编号精确配对；编号不存在的角色（如露米娅/琪露诺/帕秋莉）立绘不在包内
    const faceId = faceIdOfKey(knowledge.key);
    const paired = faceId !== undefined ? (faceByFaceId.get(faceId) ?? null) : null;

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
      mappingMethod: paired ? 'face-id-map' : 'no-portrait',
      confidence: paired ? 0.85 : 0.9,
      spellCount: spellIds.length,
    };

    if (paired) {
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

  /* ---------------- 3. 清理未被识别的占位角色 ---------------- */

  const matchedFaceIds = new Set(
    details.filter((d) => d.mappingMethod === 'face-id-map').map((d) => faceIdOfKey(d.key)),
  );
  const unmatchedFaces = faceChars
    .filter((c) => !matchedFaceIds.has(Number(JSON.parse(c.meta || '{}').faceId)))
    .map((c) => `face${String(JSON.parse(c.meta || '{}').faceId ?? '?').padStart(2, '0')}`);

  if (unmatchedFaces.length) {
    warnings.push(
      `未配对的立绘：${unmatchedFaces.join(', ')}（多为自机与中 Boss，没有符卡可用于识别）`,
    );
  }

  db.prepare('UPDATE game SET status = ? WHERE id = ?').run('extracted', gid);

  return result;
}
