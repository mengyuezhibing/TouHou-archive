/**
 * TH06NC 研究数据构建脚本（同时修复 TH06 的对话说话人标注）
 *
 * 用法: npx tsx src/scripts/build-research-th06nc.ts
 *
 * 背景：import-th06nc 只把资源行写进了数据库，研究层（对话 / 符卡 / 角色 /
 * 敌人 / 动画查看器）是空的。TH06NC 的文本是「ID 引用」架构——msg*.dat / ECL
 * / end 里存的都是 ST_MSG1_00_0 这类 ID，真实文字在 localization.msgpack
 * （1152 条 × 12 语言）。本脚本把它们串起来：
 *
 *   1. 修正资源 kind（.ecl→ecl、msg*.dat→msg、.std→std），对齐分析管线的查询
 *   2. 解码 localization.msgpack → 多语言文本表（同时导出 JSON 供 UI 使用）
 *   3. msg1-7.dat → 指令式解析（含说话方 side）→ dialogue 表（两代作品都重建）
 *   4. ECL 内嵌文本 ID（ST_ECLDATA*，即符卡名）→ spell_card 表
 *   5. ANM 元数据回填（regions / externalName）+ 精灵裁片提取（动画查看器的数据源）
 *   6. BGM 复制进 Data（music.path 原本指向游戏目录，静态服务无法覆盖）
 *   7. autoClassify（角色 / 敌机 / Boss 候选）+ identifyCharacters（符卡→角色）
 */
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/index.ts';
import { DATA_DIR } from '../core/paths.ts';
import { decodeMsgpack } from '../formats/msgpack.ts';
import { parseMsg } from '../formats/msg.ts';
import { parseThtkAnm } from '../formats/anm.ts';
import { encodePng, createCanvas } from '../core/png.ts';
import { autoClassify } from '../services/autoclassify.ts';
import { identifyCharacters, TH06_FACE_MAP_FALLBACK } from '../services/identify.ts';
import { rosterOf } from '../core/knowledge.ts';
import { resolveTexture, loadRaster } from '../services/anmPreview.ts';
import { ensureRasterPreview } from '../services/preview.ts';

type LocEntry = Record<string, string>;

const GAME_CODE = 'TH06NC';
const nowIso = () => new Date().toISOString();

/** 红魔乡关卡顺序的 Boss（EXE_BOSS_NAME_* 的键恰好按关卡排列） */
const BOSS_KEYS = ['RUMIA', 'CIRNO', 'MEILING', 'PATCHOULI', 'SAKUYA', 'REMILIA', 'FLANDRE'];

async function main(): Promise<void> {
  const gid = (db.prepare('SELECT id FROM game WHERE code = ?').get(GAME_CODE) as any)?.id;
  if (!gid) {
    console.error(`  ✗ ${GAME_CODE} 未登记，先运行 import:th06nc`);
    process.exit(1);
  }
  const gidTh06 = (db.prepare("SELECT id FROM game WHERE code = 'TH06'").get() as any)?.id;

  /* ---------- 1. 修正资源 kind ---------- */
  const fix = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args).changes as number;
  const nEcl = fix("UPDATE resource SET kind='ecl' WHERE game_id=? AND ext='.ecl'", gid);
  const nMsg = fix("UPDATE resource SET kind='msg' WHERE game_id=? AND ext='.dat' AND filename LIKE 'msg%.dat'", gid);
  const nStd = fix("UPDATE resource SET kind='std' WHERE game_id=? AND ext='.std'", gid);
  console.log(`  kind 修正: ecl ${nEcl} 个、msg ${nMsg} 个、std ${nStd} 个`);

  /* ---------- 2. 本地化表 ---------- */
  const locRow = db
    .prepare("SELECT id, path FROM resource WHERE game_id=? AND filename='localization.msgpack'")
    .get(gid) as any;
  if (!locRow) {
    console.error('  ✗ 找不到 localization.msgpack');
    process.exit(1);
  }
  const loc = decodeMsgpack(fs.readFileSync(locRow.path)) as Record<string, LocEntry>;
  const ids = Object.keys(loc);
  console.log(`  本地化表: ${ids.length} 条`);

  const practiceRow = db
    .prepare("SELECT path FROM resource WHERE game_id=? AND filename='spellpractice.msgpack'")
    .get(gid) as any;
  const practice = practiceRow ? decodeMsgpack(fs.readFileSync(practiceRow.path)) : null;

  const analysisDir = path.join(DATA_DIR, 'Game', 'TH06NC', 'Analysis');
  fs.mkdirSync(analysisDir, { recursive: true });
  fs.writeFileSync(
    path.join(analysisDir, 'localization.json'),
    JSON.stringify({ game: GAME_CODE, source: 'localization.msgpack', entries: loc }, null, 2),
  );
  if (practice) {
    fs.writeFileSync(
      path.join(analysisDir, 'spellpractice.json'),
      JSON.stringify({ game: GAME_CODE, source: 'spellpractice.msgpack', entries: practice }, null, 2),
    );
  }

  const textOf = (id: string): string | null => {
    const e = loc[id];
    if (!e) return null;
    return e.ja ?? e['zh-CN'] ?? e.en ?? Object.values(e)[0] ?? null;
  };

  /** 关卡 Boss 名（msg7 = Extra）。数据来自游戏自身的 EXE_BOSS_NAME_* 文本，取简中译名 */
  const bossNames = BOSS_KEYS.map((k) => loc[`EXE_BOSS_NAME_${k}`]?.['zh-CN'] ?? loc[`EXE_BOSS_NAME_${k}`]?.ja ?? k);

  /* ---------- 3. 对话（说话人 + 自机路线区分 + 中文翻译；TH06 / TH06NC 都重建） ---------- */
  // 旧库补列（幂等）
  const cols = new Set((db.prepare('PRAGMA table_info(dialogue)').all() as any[]).map((c) => c.name));
  if (!cols.has('text_zh')) db.prepare('ALTER TABLE dialogue ADD COLUMN text_zh TEXT').run();
  if (!cols.has('stage')) db.prepare('ALTER TABLE dialogue ADD COLUMN stage TEXT').run();
  if (!cols.has('route')) db.prepare('ALTER TABLE dialogue ADD COLUMN route TEXT').run();

  const insertDialogue = db.prepare(`
    INSERT INTO dialogue (game_id, resource_id, character_id, speaker, text, text_zh, scene, stage, route, time, encoding)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let dialogueTotal = 0;
  let dialogueMiss = 0;
  let routeSegments = 0;

  /**
   * 路线判定（每段独立）。
   * ① 场景槽位分区（权威）：TH06 系 msg 场景表中，槽位 <10 属灵梦的场次、≥10 属魔理沙的场次
   *    （反证：槽 10 段内含「出来ないぜ」「おおよそ夏だぜ」等魔理沙台词，而槽 0-9 段均为灵梦）
   * ② 无槽位信息时退回语气/名称特征
   */
  function classifyRoute(
    segLines: Array<{ text: string }>,
    sceneSlots?: number[],
  ): '灵梦' | '魔理沙' | null {
    if (sceneSlots && sceneSlots.length) {
      return Math.min(...sceneSlots) >= 10 ? '魔理沙' : '灵梦';
    }
    const all = segLines.map((l) => l.text).join('\n');
    const reimu = (all.match(/霊夢|博麗/g) ?? []).length;
    const marisa = (all.match(/魔理沙|霧雨/g) ?? []).length;
    if (reimu !== marisa) return reimu > marisa ? '灵梦' : '魔理沙';
    const ze = (all.match(/だぜ|ぜ。|ぜ！|だな[。！]|かぜ|のか？|のか。|だろ|じゃね|じゃないか|みたいだな/g) ?? []).length;
    const wa = (all.match(/だわ|かしら|わね|のね|わ[。！～\n]|わ$/gm) ?? []).length;
    if (ze > wa) return '魔理沙';
    if (wa > ze) return '灵梦';
    return null;
  }

  /**
   * 段内发言人判定（**对话箱 = 一个发言轮次**）：返回 box 序号 → 是否自机轮。
   *
   * 对话箱由行槽位配对（m0 开启新箱、m1 归入同箱，解析器的 `box` 字段），
   * 比控制记录可靠——多余的控制记录会造成箱边界错位（曾把「ふざけやがって」与
   * 「あんたなんて、あたいが…」错配成一箱，导致琪露诺的台词判给灵梦）。
   *
   * 段性质：Boss 语汇（含「強敵/なさいよ」等指向自机的挑衅）/ 自机名字 /
   *   男女语气跨箱混合且 ≥3 箱 → 对话；否则整段独白（全自机）。
   * 对话模型：Boss 标志前的箱 = 开场独白；此后逐箱严格交替；箱内出现自机名字 → Boss 箱。
   */
  function assignBoxSpeakers(segLines: Array<{ box?: number; text: string }>): Map<number, boolean> {
    const groups = new Map<number, string[]>();
    for (const l of segLines) {
      const b = l.box ?? 0;
      const arr = groups.get(b) ?? [];
      arr.push(l.text);
      groups.set(b, arr);
    }
    const boxes = [...groups.keys()].sort((a, b) => a - b);
    if (boxes.length === 0) return new Map();

    const BOSS_MARK =
      /お化け|妖怪|悪魔|食べ|喰|人間|人を|いただ|呪|祟|冥|地獄|恐怖|契約|門番|氷|あたい|退屈しのぎ|宴|悪戯|雇われ|メイド長|強敵|なさいよ|驚きなさい/;
    /**
     * Boss 自称/专属语汇：出现即**强制**判为 Boss 箱（并重置交替）。
     * 只收自指与指向自机的挑衅，不收「妖怪/人間」等双方都可能说的题材词，
     * 避免自机台词（如「妖怪退治」）被误判。
     */
    const BOSS_SELF = /あたい|お化け|食べ|喰|いただ|強敵|なさいよ|驚きなさい|雇われ|メイド長/;
    const NAME_CALL = /霊夢|博麗|魔理沙|霧雨/;
    const MASC = /だぜ|ぜ。|ぜ！|だな[。！]|だな(?=[^な]|$)|だよ|のか？|のか。|だろ|じゃね|じゃないか|みたいだな|かよ/;
    const FEM = /だわ|かしら|わね|のね|わ[。！]/;
    const textOf = new Map(boxes.map((b) => [b, groups.get(b)!.join('')]));

    const out = new Map<number, boolean>();
    const all = [...textOf.values()].join('');
    const hasBossMark = BOSS_MARK.test(all) || NAME_CALL.test(all);
    const mascBoxes = boxes.filter((b) => MASC.test(textOf.get(b)!)).length;
    const femBoxes = boxes.filter((b) => FEM.test(textOf.get(b)!)).length;
    // 对话判定：Boss 标记 / 男女语气跨箱混合 / **长段兜底**（≥6 箱的描述性台词
    // 必为对话——独白通常更短。美铃段等无任何标记的对话靠此兜底）
    const isDialog =
      hasBossMark || (mascBoxes > 0 && femBoxes > 0 && boxes.length >= 3) || boxes.length >= 6;

    if (!isDialog) {
      for (const b of boxes) out.set(b, true); // 独白：全自机
      return out;
    }

    // 开场 Boss 定位：窄标记（自称/挑衅/名字呼叫）优先，但需过**占比合理性检查**——
    // 开场独白不应超过全段 60%（美铃段中段才出现的「食べ」会把 firstBoss 拉到第 12 箱）；
    // 不过检时退回宽标记（题材词，限开头 4 箱内），再退回 0（对话从头开始）。
    let firstBoss = boxes.findIndex((b) => BOSS_SELF.test(textOf.get(b)!) || NAME_CALL.test(textOf.get(b)!));
    if (firstBoss < 0 || firstBoss > boxes.length * 0.6) {
      const broadIdx = boxes.findIndex((b) => BOSS_MARK.test(textOf.get(b)!));
      firstBoss = broadIdx >= 0 && broadIdx <= 4 ? broadIdx : 0;
    }

    for (let i = 0; i < firstBoss; i++) out.set(boxes[i], true); // 开场独白
    let isPlayer = false; // 对话从 Boss 轮开始
    for (let i = firstBoss; i < boxes.length; i++) {
      const b = boxes[i];
      const t = textOf.get(b)!;
      // Boss 自称/挑衅 → 强制 Boss 箱（防交替奇偶被前文带偏，如琪露诺的「あたい」句）
      if (BOSS_SELF.test(t)) {
        out.set(b, false);
        isPlayer = true;
        continue;
      }
      if (NAME_CALL.test(t)) {
        out.set(b, false);
        isPlayer = false;
        continue;
      }
      out.set(b, isPlayer);
      isPlayer = !isPlayer;
    }
    return out;
  }

  /** 归一化文本（供跨版本借译匹配） */
  const normText = (s: string) => s.replace(/[\s　、。！？…「」『』（）()~～ー・,."']/g, '');

  /** 借译表：TH06NC 的 ja 原文 → 官方简中（延迟构建——需先写入 game 3 的对话行） */
  let officialZh: Map<string, { zh: string; ja: string }> | null = null;
  /** 官方翻译缺口（两代作品各自的空条目），待机器翻译兜底 */
  const zhLeftovers: Array<{ gid: number; text: string }> = [];

  function buildOfficialZhMap(): Map<string, { zh: string; ja: string }> {
    const map = new Map<string, { zh: string; ja: string }>();
    const rows = db
      .prepare("SELECT text, text_zh FROM dialogue WHERE game_id=? AND text_zh IS NOT NULL AND text_zh != ''")
      .all(gid) as Array<{ text: string; text_zh: string }>;
    for (const r of rows) map.set(normText(r.text), { zh: r.text_zh, ja: r.text });
    return map;
  }

  /** 借官方简中：精确匹配 → 前缀模糊匹配（容忍跨版本断行差异） */
  function borrowZh(text: string): string | null {
    if (!officialZh) return null;
    const key = normText(text);
    const exact = officialZh.get(key);
    if (exact) return exact.zh;
    let best: { zh: string; len: number } | null = null;
    for (const [k, v] of officialZh) {
      const head = Math.min(8, k.length, key.length);
      if (k.slice(0, head) === key.slice(0, head) && head >= 6) {
        let common = 0;
        while (common < Math.min(k.length, key.length) && k[common] === key[common]) common++;
        if (!best || common > best.len) best = { zh: v.zh, len: common };
      }
    }
    return best?.zh ?? null;
  }

  /** 机器翻译兜底（MyMemory 免费端点；结果写缓存，网络不可用时静默跳过） */
  async function machineTranslate(texts: string[]): Promise<Map<string, string>> {
    const cacheFile = path.join(DATA_DIR, 'Game', 'TH06NC', 'Analysis', 'translation-cache.json');
    let cache: Record<string, string> = {};
    try {
      if (fs.existsSync(cacheFile)) cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {
      cache = {};
    }
    const out = new Map<string, string>();
    for (const t of texts) {
      if (cache[t]) {
        out.set(t, cache[t]);
        continue;
      }
      try {
        const url =
          'https://api.mymemory.translated.net/get?langpair=ja|zh-CN&q=' + encodeURIComponent(t);
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) continue;
        const data = (await res.json()) as any;
        const zh = String(data?.responseData?.translatedText ?? '').trim();
        // MyMemory 失败时会回显原文或返回大小写警告，过滤掉
        if (zh && zh !== t && !/^MYMEMORY WARNING/i.test(zh)) {
          cache[t] = zh;
          out.set(t, zh);
        }
      } catch {
        /* 无网络时跳过 */
      }
    }
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
    } catch {
      /* 缓存写入失败不影响主流程 */
    }
    return out;
  }

  for (const [targetGid, isNC] of [
    [gid, true],
    [gidTh06, false],
  ] as Array<[number, boolean]>) {
    if (!targetGid) continue;
    const msgRows = db
      .prepare("SELECT id, filename, path FROM resource WHERE game_id=? AND kind='msg' ORDER BY filename")
      .all(targetGid) as Array<{ id: number; filename: string; path: string }>;

    for (const m of msgRows) {
      const sm = m.filename.match(/msg(\d+)\.dat/i);
      const stage = sm ? Number(sm[1]) : 0;
      const boss = bossNames[stage - 1] ?? 'Boss';
      // 关卡标签：红魔乡为 6 关制，msg7 = Extra
      const stageLabel = sm ? (stage >= 7 ? 'Extra 关' : `第 ${stage} 关`) : null;
      const parsed = parseMsg(fs.readFileSync(m.path));
      const segments = parsed.segments ?? [];

      // 正文：New Classic 是文本 ID，查本地化表落回原文（同时取简中翻译）
      // TH06 原版：与 TH06NC 是同一部作品（对话文本一致）→ 借官方简中；缺口留待机器翻译兜底
      if (!isNC && !officialZh) officialZh = buildOfficialZhMap();
      const displayLines = parsed.lines.map((l) => {
        const raw = l.text.trim();
        const entry = isNC ? loc[raw] : undefined;
        if (isNC && !entry) dialogueMiss += 1;
        const text = entry?.ja ?? raw;
        let textZh: string | null = entry?.['zh-CN'] || null;
        if (!isNC) textZh = borrowZh(text);
        // 官方翻译缺口（含 TH06NC 本身的空条目）→ 记录待机器翻译
        if (text && !textZh) zhLeftovers.push({ gid: targetGid, text });
        return { ...l, text, textZh };
      });

      db.prepare('DELETE FROM dialogue WHERE resource_id=?').run(m.id);
      // 逐段独立处理（交换编号在段内重置，绝不能跨段合并）：
      //   · 路线 = 场景槽位分区（<10 = 灵梦的场次，≥10 = 魔理沙的场次）
      //   · 说话人 = 段内发言轮次（交换）：自机轮 → 路线主角名；Boss 轮 → 关卡 Boss 名
      const segInfos = segments.map((s) => {
        const segLines = displayLines.slice(s.lineStart, s.lineEnd);
        const route = classifyRoute(segLines, s.sceneSlots);
        return { route, turns: assignBoxSpeakers(segLines) };
      });
      displayLines.forEach((line) => {
        const info = segInfos[line.segment ?? 0];
        const routeName = info?.route ?? null;
        const isPlayerTurn = info?.turns.get(line.box ?? 0) ?? true;
        const speaker = isPlayerTurn ? (routeName ?? '自机') : boss;
        const scene = `场景 ${Math.floor(line.index / 40) + 1}${routeName ? ` · ${routeName}路线` : ''}`;
        insertDialogue.run(
          targetGid,
          m.id,
          speaker,
          line.text,
          line.textZh ?? null,
          scene,
          stageLabel,
          routeName,
          line.time ?? 0,
          isNC ? 'id:ja' : line.encoding,
        );
        dialogueTotal += 1;
      });
      routeSegments += segments.length;
    }
  }
  console.log(
    `  对话: ${dialogueTotal} 行入库（对白段 ${routeSegments} 个，发言轮次说话人 + 自机路线；TH06NC 未解析 ID ${dialogueMiss} 个）`,
  );

  // 官方翻译缺口（两代作品）→ 机器翻译兜底
  if (zhLeftovers.length) {
    const uniq = [...new Set(zhLeftovers.map((x) => x.text))].filter(Boolean);
    const extra = await machineTranslate(uniq);
    let filled = 0;
    for (const [ja, zh] of extra) {
      filled += db
        .prepare('UPDATE dialogue SET text_zh=? WHERE text=? AND (text_zh IS NULL OR text_zh = ?)')
        .run(zh, ja, '').changes as number;
    }
    console.log(`  翻译: 官方缺口 ${uniq.length} 条 → 机器翻译补齐 ${filled} 行`);
  }

  /* ---------- 4. 符卡（ECL 内嵌文本 ID） ---------- */
  db.prepare("DELETE FROM spell_card WHERE game_id=? AND source='auto-extract'").run(gid);
  const insertSpell = db.prepare(`
    INSERT INTO spell_card (game_id, boss_id, boss, name, difficulty, duration, description, evaluation, reference, source, created_time)
    VALUES (?, NULL, '', ?, 'Unknown', 0, ?, '', '', 'auto-extract', ?)
  `);
  const eclRe = /^ST_ECLDATA(\d+)_SUB(\d+)_(\d+)$/;
  const eclIds = ids.filter((k) => eclRe.test(k)).sort();
  const seenNames = new Set<string>();
  let spellCount = 0;
  for (const key of eclIds) {
    const name = textOf(key);
    if (!name || seenNames.has(name)) continue;
    seenNames.add(name);
    const m = key.match(eclRe)!;
    const zh = loc[key]['zh-CN'];
    const desc =
      `来自 ecldata${m[1]}.ecl 的内嵌文本（sub ${m[2]}），自动提取` +
      (zh && zh !== name ? `；简中：${zh}` : '');
    insertSpell.run(gid, name, desc, nowIso());
    spellCount += 1;
  }
  console.log(`  符卡: ${spellCount} 张入库`);

  /* ---------- 5. ANM 元数据 + 精灵提取（动画查看器数据源） ---------- */
  const spritesDir = path.join(DATA_DIR, 'Game', 'TH06NC', 'Sprites');
  const anmRows = db
    .prepare("SELECT id, code, filename, path, meta FROM resource WHERE game_id=? AND ext='.anm'")
    .all(gid) as Array<{ id: number; code: string; filename: string; path: string; meta: string }>;

  // 幂等：清掉上一轮生成的精灵 / 图集资源（文件会在重跑时覆盖）
  db.prepare(
    `DELETE FROM resource WHERE game_id=? AND category IN ('sprite','sheet') AND meta LIKE '%"sourceAnm"%'`,
  ).run(gid);

  // code 分配：接续现有 TH06NC_IMAGE_* 的最大编号
  const imgPrefix = 'TH06NC_IMAGE_';
  const maxImg = db
    .prepare(
      `SELECT COALESCE(MAX(CAST(SUBSTR(code, ${imgPrefix.length + 1}) AS INTEGER)), 0) AS n
       FROM resource WHERE game_id=? AND code LIKE ?`,
    )
    .get(gid, `${imgPrefix}%`) as any;
  let imgCounter = Number(maxImg?.n ?? 0);
  const nextImageCode = () => `${imgPrefix}${String(++imgCounter).padStart(4, '0')}`;

  const insertResource = db.prepare(`
    INSERT INTO resource (code, game_id, archive_id, filename, display_name, resource_type, kind,
      category, role, ext, path, size, hash, entry_offset, meta, created_time)
    VALUES (?, ?, NULL, ?, ?, 'extracted', 'image', ?, NULL, '.png', ?, ?, '', 0, ?, ?)
  `);

  let anmMeta = 0;
  let spriteCount = 0;
  let sheetCount = 0;

  for (const a of anmRows) {
    const info = parseThtkAnm(fs.readFileSync(a.path));
    if (!info) continue;

    // 5a. 元数据回填（与原版 ANM 的 meta 结构对齐）
    const meta = JSON.parse(a.meta || '{}');
    meta.numSprites = info.sprites;
    meta.numScripts = info.scripts;
    meta.format = info.format;
    meta.version = info.version;
    meta.thtxOffset = info.thtxOffset;
    meta.externalName = info.externalName;
    meta.externalAlphaName = info.externalAlphaName;
    meta.regions = info.regions;
    meta.notes = ['thtk 编译格式（贴图外置），精灵与贴图由 build-research 关联'];
    db.prepare('UPDATE resource SET meta=? WHERE id=?').run(JSON.stringify(meta), a.id);
    anmMeta += 1;

    // 5b. 贴图定位 + 精灵裁片（meta.sourceAnm 供动画查看器关联）
    const base = a.filename.replace(/\.anm$/i, '');
    const texPath = resolveTexture(a.path, info.externalName ?? info.externalAlphaName, gid);
    const tex = texPath ? await loadRaster(texPath) : null;
    if (!tex || !texPath) continue;

    const scale = info.width > 0 ? tex.width / info.width : 1;
    const spriteDir = path.join(spritesDir, base);
    fs.mkdirSync(spriteDir, { recursive: true });

    for (const r of info.regions) {
      const w = Math.round(r.w * scale);
      const h = Math.round(r.h * scale);
      if (w < 2 || h < 2) continue;
      const crop = createCanvas(w, h);
      const x0 = Math.round(r.x * scale);
      const y0 = Math.round(r.y * scale);
      for (let y = 0; y < h; y++) {
        const sy = y0 + y;
        if (sy < 0 || sy >= tex.height) continue;
        for (let x = 0; x < w; x++) {
          const sx = x0 + x;
          if (sx < 0 || sx >= tex.width) continue;
          const si = (sy * tex.width + sx) * 4;
          const di = (y * w + x) * 4;
          crop.data[di] = tex.data[si];
          crop.data[di + 1] = tex.data[si + 1];
          crop.data[di + 2] = tex.data[si + 2];
          crop.data[di + 3] = tex.data[si + 3];
        }
      }
      const name = `${base}_${String(r.index).padStart(4, '0')}.png`;
      const filePath = path.join(spriteDir, name);
      fs.writeFileSync(filePath, encodePng(crop));
      insertResource.run(
        nextImageCode(),
        gid,
        name,
        name,
        'sprite',
        filePath,
        fs.statSync(filePath).size,
        JSON.stringify({ sourceAnm: a.filename, spriteId: r.index, texture: texPath }),
        nowIso(),
      );
      spriteCount += 1;
    }

    // 5c. 图集（整张贴图作为 sheet，动画查看器用它做对照底图）
    const sheetPath = path.join(spriteDir, 'sheet.png');
    const texPng = texPath.toLowerCase().endsWith('.png') ? texPath : await ensureRasterPreview(texPath);
    if (texPng) {
      fs.copyFileSync(texPng, sheetPath);
      insertResource.run(
        nextImageCode(),
        gid,
        'sheet.png',
        `${base} 图集`,
        'sheet',
        sheetPath,
        fs.statSync(sheetPath).size,
        JSON.stringify({ sourceAnm: a.filename, texture: texPath }),
        nowIso(),
      );
      sheetCount += 1;
    }
  }
  console.log(`  ANM: 元数据 ${anmMeta} 个、精灵 ${spriteCount} 张、图集 ${sheetCount} 张`);

  /* ---------- 6. BGM 落盘（原 path 指向游戏目录，静态服务覆盖不到） ---------- */
  const bgmDir = path.join(DATA_DIR, 'Game', 'TH06NC', 'BGM');
  fs.mkdirSync(bgmDir, { recursive: true });
  const bgmRows = db.prepare('SELECT id, path, filename FROM music WHERE game_id=?').all(gid) as Array<{
    id: number;
    path: string;
    filename: string;
  }>;
  let bgmCopied = 0;
  for (const t of bgmRows) {
    if (!t.path || !fs.existsSync(t.path)) continue;
    const dest = path.join(bgmDir, t.filename);
    if (!fs.existsSync(dest)) fs.copyFileSync(t.path, dest);
    db.prepare('UPDATE music SET path=? WHERE id=?').run(dest, t.id);
    bgmCopied += 1;
  }
  console.log(`  BGM: ${bgmCopied} 首已落盘到 Data/Game/TH06NC/BGM`);

  /* ---------- 7. 角色 / 敌机 / Boss + 身份识别 ---------- */
  const cls = autoClassify(GAME_CODE);
  console.log(
    `  自动分类: 角色 ${cls.characters}（资产 ${cls.characterAssets}）、敌机 ${cls.enemies}、Boss 候选 ${cls.bosses}`,
  );
  if (cls.warnings.length) console.log(`    警告: ${cls.warnings.join('；')}`);

  const ident = identifyCharacters(GAME_CODE);
  console.log(
    `  身份识别: 关联符卡 ${ident.spellsLinked}、弹幕 ${ident.patternsLinked}、动画 ${ident.animationsLinked}`,
  );
  if (ident.warnings.length) console.log(`    提示: ${ident.warnings.join('；')}`);

  /* ---------- 7.5 自机与玩家立绘的直命名 ---------- */
  // Boss 立绘靠符卡名配对；灵梦 / 魔理沙是自机，没有 Boss 符卡，
  // 按「立绘编号对照表 + roster 显示名」直接指派（编号与原版同构）。
  const nameByKey = new Map(rosterOf(GAME_CODE).map((k) => [k.key, k.name]));
  let named = 0;
  for (const [faceIdStr, key] of Object.entries(TH06_FACE_MAP_FALLBACK)) {
    const display = nameByKey.get(key);
    if (!display) continue;
    const faceId = Number(faceIdStr);
    const nn = String(faceId).padStart(2, '0');
    // 自机体表（slpl→playerNN）：autoclassify 的 key 为 playerNN
    const n1 = db
      .prepare(
        `UPDATE character SET name=? WHERE game_id=? AND json_extract(meta,'$.kind')='player'
         AND json_extract(meta,'$.key')=?`,
      )
      .run(display, gid, `player${nn}`).changes as number;
    // 玩家立绘（faceNN）：未被符卡配对的保留行（faceId 在 meta 里是补零字符串）
    const n2 = db
      .prepare(
        `UPDATE character SET name=? WHERE game_id=? AND json_extract(meta,'$.kind')='face'
         AND json_extract(meta,'$.faceId')=? AND name LIKE '%待指派%'`,
      )
      .run(`${display}（立绘）`, gid, String(faceId).padStart(2, '0')).changes as number;
    named += n1 + n2;
  }
  console.log(`  直命名: ${named} 个角色（自机 / 玩家立绘，按立绘编号对照表）`);

  /* ---------- 7.6 BGM 元数据标注（标题 / 场景 / Boss） ---------- */
  // 数据源 = 游戏自带音乐室文本：localization 的 MD_NN_TITLE / MD_NN_DESC
  // （DESC 形如「No.3 妖魔夜行\n　ルーミアのテーマです。」→ 场景与 Boss 可自动推导）
  const BOSS_NAME_MAP: Array<[RegExp, string]> = [
    [/ルーミア/, '露米娅'],
    [/チルノ/, '琪露诺'],
    [/美鈴/, '红美铃'],
    [/パチュリー/, '帕秋莉·诺蕾姬'],
    [/咲夜/, '十六夜咲夜'],
    [/レミリア/, '蕾米莉亚·斯卡蕾特'],
    [/フランドール/, '芙兰朵露·斯卡蕾特'],
  ];
  const stageFromDesc = (desc: string): string | null => {
    if (/タイトル画面/.test(desc)) return '标题画面';
    if (/エンディング/.test(desc)) return '结局';
    if (/スタッフロール/.test(desc)) return '制作人员';
    if (/エキストラ/.test(desc)) return 'Extra 关';
    if (/最終面/.test(desc)) return '第 6 关'; // 红魔乡为 6 关制
    const m = desc.match(/[１-９]面/); // 全角数字
    if (m) return `第 ${'１２３４５６７８９'.indexOf(m[0][0]) + 1} 关`;
    return null;
  };

  let bgmAnnotated = 0;
  let bgmDupRemoved = 0;
  for (const targetGid of [gid, gidTh06]) {
    if (!targetGid) continue;
    // 去重：同一文件路径的重复行（导入来源重叠造成）只保留最早一条
    bgmDupRemoved += db
      .prepare(
        `DELETE FROM music WHERE game_id=? AND id NOT IN
         (SELECT MIN(id) FROM music WHERE game_id=? GROUP BY path)`,
      )
      .run(targetGid, targetGid).changes as number;

    const tracks = db
      .prepare('SELECT id, filename FROM music WHERE game_id=? ORDER BY index_num')
      .all(targetGid) as Array<{ id: number; filename: string }>;
    let lastStage: string | null = null;
    for (const t of tracks) {
      const num = Number(t.filename.match(/th06_(\d+)/)?.[1] ?? 0);
      if (!num) continue;
      const md = 'MD_' + String(num - 1).padStart(2, '0');
      const title = loc[`${md}_TITLE`]?.ja?.trim() || null;
      const desc = loc[`${md}_DESC`]?.ja ?? '';
      // 归属行 = 第 2 行（「N面のテーマです。」或「<角色>のテーマです。」）；
      // 评注行里也会提到别的关卡（如「４面以降が…」），不可全 desc 扫描
      const assocLine = desc.split('\n')[1] ?? '';
      let stage = stageFromDesc(assocLine);
      let boss: string | null = null;
      for (const [re, zh] of BOSS_NAME_MAP) {
        if (re.test(assocLine)) {
          boss = zh;
          break;
        }
      }
      if (boss && !stage) stage = lastStage; // Boss 曲沿用前一「面」的场景
      if (stage && !boss) lastStage = stage;
      // 曲目标识：关卡场景曲（无 Boss）= 道中曲；Boss 主题曲 = Boss 曲
      const musicKind = boss
        ? 'Boss 曲'
        : stage && /^(第 \d+ 关|Extra 关)$/.test(stage)
          ? '道中曲'
          : null;
      const metaRow = db.prepare('SELECT meta FROM music WHERE id=?').get(t.id) as any;
      const meta = JSON.parse(metaRow?.meta || '{}');
      if (musicKind) meta.musicKind = musicKind;
      else delete meta.musicKind;
      db.prepare('UPDATE music SET title=?, boss=?, stage=?, meta=? WHERE id=?').run(
        title,
        boss,
        stage,
        JSON.stringify(meta),
        t.id,
      );
      bgmAnnotated += 1;
    }
  }
  console.log(`  BGM 标注: ${bgmAnnotated} 首（标题/场景/Boss 来自游戏自带音乐室文本；去重 ${bgmDupRemoved} 行）`);

  /* ---------- 8. 汇总 ---------- */
  const count = (t: string) => (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE game_id=?`).get(gid) as any).n;
  const bossNamed = (db
    .prepare("SELECT COUNT(*) n FROM spell_card WHERE game_id=? AND boss IS NOT NULL AND boss != ''")
    .get(gid) as any).n;
  const withSpeaker = (db
    .prepare('SELECT COUNT(*) n FROM dialogue WHERE game_id=? AND speaker IS NOT NULL')
    .get(gid) as any).n;
  console.log('');
  console.log(
    `  完成。对话 ${count('dialogue')}（有说话人 ${withSpeaker}）、符卡 ${count('spell_card')}（识别 Boss ${bossNamed}）、角色 ${count('character')}、敌机 ${count('enemy')}、Boss ${count('boss')}`,
  );
}

main();
