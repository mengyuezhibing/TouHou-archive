import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { db, nowIso, gameIdByCode, setResourceTags } from '../db/index.ts';
import { gameCacheDir, gameSubDir, safeFileName } from '../core/paths.ts';
import { parseDat, readEntryPayload, sliceEntry, type DatEntry } from '../formats/dat.ts';
import { parseAnm, extractSpriteImage, parseThtkAnm, parseThtx, type ThtkAnmInfo } from '../formats/anm.ts';
import { isThbgm, parseThbgm } from '../formats/bgm.ts';
import { parseEcl, analyzeBossPhases } from '../formats/ecl.ts';
import { parseMsg } from '../formats/msg.ts';
import { createCanvas, decodePng, encodePng } from '../core/png.ts';
import { decodeJpeg, applyBlackAsAlpha } from '../core/jpeg.ts';
import { analyzeColors } from '../core/color.ts';
import { detectMagic } from '../core/magic.ts';
import { classifyEntry, detectCharacterHint } from './classify.ts';
import { packSheet, type SheetFrame } from './sheet.ts';

/**
 * 解包流水线（对应设计文档第四节，写入《数据库设计文档 V1.0》的表结构）：
 *
 *   DAT 文件 → Archive Parser → File Index → Resource Extractor → Converter → Database
 *
 * 落库分布：
 *   Archive        归档记录
 *   Resource       每条素材（含 resource_type 枚举与可读 code）
 *   Asset_Image    图片尺寸、格式、主色
 *   Animation / Animation_Frame   ANM 脚本还原出的动画与帧序列
 *   Character / Character_Asset   角色实体及其素材关联
 *   Bullet_Pattern / Bullet_Action    ECL 分析出的弹幕模式与动作时间轴
 *   Music / Dialogue / Tag+Resource_Tag
 */

export interface ExtractModes {
  images: boolean;
  audio: boolean;
  text: boolean;
  scripts: boolean;
  sprites: boolean;
  sheets: boolean;
}

export const DEFAULT_MODES: ExtractModes = {
  images: true,
  audio: true,
  text: true,
  scripts: true,
  sprites: true,
  sheets: true,
};

export interface ExtractRequest {
  gameId: string;
  datFiles: string[];
  modes?: Partial<ExtractModes>;
  maxSpritesPerAnm?: number;
  /** 忽略缓存强制重新解析；默认 false 时按 SHA256 比对跳过未变化的归档 */
  force?: boolean;
}

export interface ExtractSummary {
  gameId: string;
  archives: number;
  skipped: number;
  assets: number;
  sprites: number;
  sheets: number;
  animations: number;
  animationFrames: number;
  characterAssets: number;
  bgmTracks: number;
  msgLines: number;
  patterns: number;
  patternActions: number;
  characters: number;
  bossPhases: number;
  warnings: string[];
  durationMs: number;
}

export type ProgressFn = (phase: string, current: number, total: number, message: string) => void;

function md5(buf: Buffer): string {
  return crypto.createHash('md5').update(buf).digest('hex');
}

function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/** 把内部细分类型映射为文档定义的 resource_type 枚举 */
function toResourceType(kind: string): string {
  switch (kind) {
    case 'image':
    case 'sprite':
      return 'IMAGE';
    case 'anm':
      return 'ANIMATION';
    case 'ecl':
    case 'std':
    case 'script':
      return 'SCRIPT';
    case 'msg':
    case 'text':
      return 'TEXT';
    case 'bgm':
      return 'MUSIC';
    case 'audio':
      return 'AUDIO';
    default:
      return 'BINARY';
  }
}

/**
 * 从对话文本中提取说话人（形如「門番「ここは…」」）。
 * 需排除形如「魔符『マスタースパーク』」的符卡名——它们同样以引号开头，但不是说话人。
 */
function extractSpeaker(text: string): string | null {
  const m = text.match(/^([^\s「『"]{1,12})[「『]/);
  if (!m) return null;
  const name = m[1];
  if (/[符札]|スペル/.test(name)) return null;
  return name;
}

/** 素材编码分配器：按「作品_分类_序号」生成可读 code，采用最小空闲策略保证幂等 */
class CodeAllocator {
  private used = new Set<string>();
  constructor(private prefix: string, existing: string[]) {
    for (const c of existing) this.used.add(c);
  }

  next(category: string): string {
    const key = `${this.prefix}_${category.toUpperCase()}_`;
    let n = 1;
    let code = `${key}${String(n).padStart(4, '0')}`;
    while (this.used.has(code)) {
      n++;
      code = `${key}${String(n).padStart(4, '0')}`;
    }
    this.used.add(code);
    return code;
  }
}

function defaultCharacterName(base: string, role: string, category: string): string {
  if (role === 'player') return '自机（待命名）';
  if (role === 'boss') return `${base} · Boss`;
  if (role === 'enemy') return `${base} · 敌机`;
  if (category === 'portrait') return `${base} · 立绘组`;
  return `${base}（待命名）`;
}

/**
 * 从 ANM 的 alpha 边界与实际像素包围盒推导碰撞模型（文档第 12 节）。
 * ANM 每条 sprite 自带 left/top/right/bottom 的 alpha 测试边界，
 * 这里再用实际不透明像素的包围盒交叉验证，取更可靠的一方。
 */
function buildCollision(
  alpha: { left: number; top: number; right: number; bottom: number } | undefined,
  img: { width: number; height: number; data: Buffer } | null,
): Record<string, unknown> | null {
  let measured: { left: number; top: number; right: number; bottom: number } | null = null;
  if (img) {
    let minX = img.width;
    let minY = img.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (img.data[(y * img.width + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX >= 0) measured = { left: minX, top: minY, right: maxX, bottom: maxY };
  }

  const anmBox =
    alpha && alpha.right > alpha.left && alpha.bottom > alpha.top
      ? { left: alpha.left, top: alpha.top, right: alpha.right, bottom: alpha.bottom }
      : null;

  const box = measured ?? anmBox;
  if (!box) return null;

  const w = box.right - box.left + 1;
  const h = box.bottom - box.top + 1;
  return {
    box,
    x: Number((box.left + w / 2).toFixed(2)),
    y: Number((box.top + h / 2).toFixed(2)),
    radius: Number((Math.max(w, h) / 2).toFixed(2)),
    /** 自机判定点建议半径（东方自机判定点通常为 2~3px） */
    hitRadius: Number(Math.max(1, Math.min(4, Math.min(w, h) / 8)).toFixed(2)),
    source: measured ? 'measured' : 'anm-alpha-bounds',
  };
}

function numSpritesHeuristic(slice: Buffer): number {
  if (slice.length < 0x20) return 0;
  const n = slice.readUInt32LE(0);
  return n > 0 && n < 20000 ? n : 0;
}

function subDirFor(category: string, assetsDir: string): string {
  const sub = ['sprite', 'image', 'portrait', 'bullet', 'effect', 'background', 'item'].includes(category)
    ? category.charAt(0).toUpperCase() + category.slice(1) + 's'
    : category.charAt(0).toUpperCase() + category.slice(1);
  const dir = path.join(assetsDir, sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

interface ResourceInsert {
  code: string;
  archiveId: number | null;
  entryName: string;
  displayName: string;
  ext: string;
  kind: string;
  category: string;
  role: string;
  size: number;
  entryOffset: number;
  cachePath: string | null;
  hash: string;
  tags: string[];
  meta: Record<string, unknown>;
  width?: number;
  height?: number;
  imageFormat?: string;
  hasAlpha?: boolean;
  dominantColor?: string;
  colorNames?: string[];
}

export async function extractGame(req: ExtractRequest, onProgress?: ProgressFn): Promise<ExtractSummary> {
  const started = Date.now();
  const modes: ExtractModes = { ...DEFAULT_MODES, ...(req.modes ?? {}) };
  const warnings: string[] = [];
  const summary: ExtractSummary = {
    gameId: req.gameId,
    archives: 0,
    skipped: 0,
    assets: 0,
    sprites: 0,
    sheets: 0,
    animations: 0,
    animationFrames: 0,
    characterAssets: 0,
    bgmTracks: 0,
    msgLines: 0,
    patterns: 0,
    patternActions: 0,
    characters: 0,
    bossPhases: 0,
    warnings,
    durationMs: 0,
  };

  const gid = gameIdByCode(req.gameId);
  if (!gid) throw new Error(`作品 ${req.gameId} 尚未登记，请先执行扫描`);

  const assetsDir = gameSubDir(req.gameId, 'Assets');
  const spritesDir = gameSubDir(req.gameId, 'Sprites');
  const sheetsDir = gameSubDir(req.gameId, 'Sheets');
  const analysisDir = gameSubDir(req.gameId, 'Analysis');
  const bgmDir = gameSubDir(req.gameId, 'BGM');

  // ---------------------------------------------------------------- 预编译语句

  const insertResource = db.prepare(`
    INSERT INTO resource (code, game_id, archive_id, filename, display_name, resource_type, kind, category, role,
                          ext, path, size, hash, entry_offset, meta, created_time)
    VALUES (@code, @gameId, @archiveId, @filename, @displayName, @resourceType, @kind, @category, @role,
            @ext, @path, @size, @hash, @entryOffset, @meta, @createdTime)
  `);

  const insertImage = db.prepare(`
    INSERT INTO asset_image (resource_id, width, height, format, thumbnail, has_alpha, dominant_color, color_names)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(resource_id) DO UPDATE SET
      width = excluded.width, height = excluded.height, format = excluded.format,
      has_alpha = excluded.has_alpha, dominant_color = excluded.dominant_color, color_names = excluded.color_names
  `);

  const insertAnimation = db.prepare(`
    INSERT INTO animation (resource_id, name, frame_count, fps, loop, meta) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertAnimationFrame = db.prepare(`
    INSERT INTO animation_frame (animation_id, image_id, frame_index, duration, x, y, w, h, rotation, scale)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertCharacter = db.prepare(`
    INSERT INTO character (game_id, name, nickname, type, description, sprite_count, animation_count, colors, source, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCharacterAsset = db.prepare(`
    INSERT OR IGNORE INTO character_asset (character_id, resource_id, asset_type) VALUES (?, ?, ?)
  `);

  const insertEnemy = db.prepare(`
    INSERT INTO enemy (game_id, name, type, hp, speed, description, sprite_id, meta) VALUES (?, ?, ?, 0, 0, ?, NULL, ?)
  `);

  const insertMusic = db.prepare(`
    INSERT INTO music (game_id, index_num, title, filename, codec, size, path, boss, stage, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
  `);

  const insertDialogue = db.prepare(`
    INSERT INTO dialogue (game_id, resource_id, character_id, speaker, text, scene, time, encoding)
    VALUES (?, ?, NULL, ?, ?, NULL, ?, ?)
  `);

  const insertPattern = db.prepare(`
    INSERT INTO bullet_pattern (code, game_id, spell_id, resource_id, name, type, duration, difficulty, params, origin, tags, note, created_time, updated_time)
    VALUES (@code, @gameId, NULL, @resourceId, @name, @type, @duration, '', @params, 'analyzed', @tags, @note, @now, @now)
  `);
  const insertAction = db.prepare(`
    INSERT INTO bullet_action (pattern_id, time, action_type, parameter) VALUES (?, ?, ?, ?)
  `);

  const insertArchive = db.prepare(`
    INSERT INTO archive (game_id, filename, file_path, type, size, hash, entry_count, layout, confidence, notes, parsed_time)
    VALUES (@gameId, @filename, @filePath, @type, @size, @hash, @entryCount, @layout, @confidence, @notes, @now)
    ON CONFLICT(game_id, file_path) DO UPDATE SET
      filename = excluded.filename, type = excluded.type, size = excluded.size, hash = excluded.hash,
      entry_count = excluded.entry_count, layout = excluded.layout, confidence = excluded.confidence,
      notes = excluded.notes, parsed_time = excluded.parsed_time
  `);
  const selectArchiveId = db.prepare('SELECT id, hash FROM archive WHERE game_id = ? AND file_path = ?');

  /**
   * 写入归档记录并返回主键。
   * UPSERT 走 DO UPDATE 分支时 lastInsertRowid 不可靠，必须回查。
   */
  function upsertArchive(
    filename: string,
    filePath: string,
    type: string,
    size: number,
    hash: string,
    entryCount: number,
    layout: string,
    confidence: number,
    notes: string,
  ): number {
    insertArchive.run({
      gameId: gid,
      filename,
      filePath,
      type,
      size,
      hash,
      entryCount,
      layout,
      confidence,
      notes,
      now: nowIso(),
    });
    return ((selectArchiveId.get(gid, filePath) as { id: number } | undefined)?.id) ?? 0;
  }

  function saveFile(dir: string, fileName: string, data: Buffer): string {
    const target = path.join(dir, safeFileName(fileName));
    fs.writeFileSync(target, data);
    return target;
  }

  // ---------------------------------------------------------------- SHA256 预检

  /**
   * 先于任何清理动作做内容比对：
   * 若全部归档的 SHA256 都未变化，直接短路返回。
   * （若把比对放在清理之后，未变化的归档会导致派生表被白白清空。）
   */
  const shaByPath = new Map<string, string>();
  const changedFiles: string[] = [];

  for (const datPath of req.datFiles) {
    try {
      const stat = fs.statSync(datPath);
      if (stat.size > 2 * 1024 * 1024 * 1024) continue;
      const sha = crypto.createHash('sha256').update(fs.readFileSync(datPath)).digest('hex');
      shaByPath.set(datPath, sha);
      const prev = selectArchiveId.get(gid, datPath) as { id: number; hash?: string } | undefined;
      if (req.force || prev?.hash !== sha) changedFiles.push(datPath);
    } catch {
      changedFiles.push(datPath);
    }
  }

  if (!req.force && req.datFiles.length > 0 && changedFiles.length === 0) {
    summary.skipped = req.datFiles.length;
    summary.archives = req.datFiles.length;
    summary.durationMs = Date.now() - started;
    onProgress?.('skip', 1, 1, `全部 ${req.datFiles.length} 个归档内容未变化（SHA256 一致），跳过解析`);
    return summary;
  }

  // ---------------------------------------------------------------- 幂等性准备

  const hasNormalDat = req.datFiles.some((f) => !/thbgm|bgm/i.test(path.basename(f)));
  const hasBgmDat = req.datFiles.some((f) => /thbgm|bgm/i.test(path.basename(f)));

  if (hasNormalDat) {
    // resource 的删除会级联清理 asset_image / animation / character_asset / resource_tag
    db.prepare('DELETE FROM bullet_pattern WHERE game_id = ? AND origin = ?').run(gid, 'analyzed');
    db.prepare('DELETE FROM character WHERE game_id = ?').run(gid);
    db.prepare('DELETE FROM enemy WHERE game_id = ?').run(gid);
    db.prepare('DELETE FROM boss WHERE game_id = ?').run(gid);
    db.prepare('DELETE FROM bullet WHERE game_id = ?').run(gid);
    db.prepare('DELETE FROM dialogue WHERE game_id = ?').run(gid);
  }
  if (hasBgmDat) {
    db.prepare('DELETE FROM music WHERE game_id = ?').run(gid);
  }
  for (const datPath of req.datFiles) {
    const row = selectArchiveId.get(gid, datPath) as { id: number } | undefined;
    if (row) db.prepare('DELETE FROM resource WHERE game_id = ? AND archive_id = ?').run(gid, row.id);
  }

  const existingCodes = (db.prepare('SELECT code FROM resource WHERE game_id = ?').all(gid) as Array<{ code: string }>).map((r) => r.code);
  const alloc = new CodeAllocator(req.gameId, existingCodes);

  /** 写入素材，返回 resource.id */
  function writeResource(a: ResourceInsert): number {
    const info = insertResource.run({
      code: a.code,
      gameId: gid,
      archiveId: a.archiveId,
      filename: a.entryName,
      displayName: a.displayName,
      resourceType: toResourceType(a.kind),
      kind: a.kind,
      category: a.category,
      role: a.role,
      ext: a.ext,
      path: a.cachePath,
      size: a.size,
      hash: a.hash,
      entryOffset: a.entryOffset,
      meta: JSON.stringify(a.meta),
      createdTime: nowIso(),
    });
    const rid = info.lastInsertRowid as number;

    if (a.width || a.height) {
      insertImage.run(
        rid,
        a.width ?? 0,
        a.height ?? 0,
        a.imageFormat ?? '',
        a.hasAlpha ? 1 : 0,
        a.dominantColor ?? '',
        JSON.stringify(a.colorNames ?? []),
      );
    }
    if (a.tags.length) setResourceTags(rid, a.tags);
    summary.assets++;
    return rid;
  }

  // 角色聚合
  const characterAgg = new Map<
    string,
    { name: string; role: string; source: string; sprites: number; animations: number; colors: Map<string, number>; tags: Set<string>; resourceIds: number[] }
  >();

  // ---------------------------------------------------------------- 归档处理

  for (let fi = 0; fi < req.datFiles.length; fi++) {
    const datPath = req.datFiles[fi];
    const fileName = path.basename(datPath);
    onProgress?.('archive', fi, req.datFiles.length, `读取 ${fileName}`);

    let buf: Buffer;
    try {
      const stat = fs.statSync(datPath);
      if (stat.size > 2 * 1024 * 1024 * 1024) {
        warnings.push(`${fileName} 超过 2GB，已跳过`);
        continue;
      }
      buf = fs.readFileSync(datPath);
    } catch (e) {
      warnings.push(`无法读取 ${fileName}：${(e as Error).message}`);
      continue;
    }

    // 复用预检阶段算出的哈希（文档第 15 节性能设计）
    const sha = shaByPath.get(datPath) ?? crypto.createHash('sha256').update(buf).digest('hex');


    // ---- thbgm.dat：曲目包独立流程
    if (isThbgm(buf, fileName)) {
      onProgress?.('bgm', fi, req.datFiles.length, `解析 BGM 包 ${fileName}`);
      const parsed = parseThbgm(buf);
      upsertArchive(fileName, datPath, 'bgm', buf.length, sha, parsed.tracks.length, 'thbgm', parsed.confidence, parsed.notes.join('；'));
      summary.archives++;

      for (const t of parsed.tracks) {
        let cachePath: string | null = null;
        if (modes.audio && t.size > 0) {
          const slice = buf.subarray(t.offset, Math.min(t.offset + t.size, buf.length));
          const ext = t.codec === 'ogg' ? '.ogg' : t.codec === 'wav' ? '.wav' : '.bin';
          const safeTitle = safeFileName(t.title).replace(/\s+/g, '_').slice(0, 60);
          cachePath = saveFile(bgmDir, `${String(t.index + 1).padStart(2, '0')}_${safeTitle}${ext}`, Buffer.from(slice));
        }
        insertMusic.run(gid, t.index, t.title, t.fileName, t.codec, t.size, cachePath, JSON.stringify({ notes: parsed.notes }));
        // 曲目同样登记为资源，便于统一检索与打标签
        writeResource({
          code: alloc.next('music'),
          archiveId: null,
          entryName: t.fileName,
          displayName: t.title || t.fileName,
          ext: t.codec === 'ogg' ? '.ogg' : '.wav',
          kind: 'bgm',
          category: 'audio',
          role: 'ui',
          size: t.size,
          entryOffset: t.offset,
          cachePath,
          hash: '',
          tags: ['BGM', '曲目'],
          meta: { index: t.index, codec: t.codec, sourceArchive: fileName },
        });
        summary.bgmTracks++;
      }
      await tick();
      continue;
    }

    // ---- 普通 DAT 归档
    const parsed = parseDat(buf, { gameId: req.gameId });
    const archiveId = upsertArchive(
      fileName,
      datPath,
      'dat',
      buf.length,
      sha,
      parsed.entries.length,
      parsed.layout,
      parsed.confidence,
      parsed.notes.join('；'),
    );
    summary.archives++;
    if (parsed.mayBeEncrypted && parsed.kind === 'probed') {
      warnings.push(`${fileName}：该版本归档数据疑似经过加密，提取出的内容可能无法直接解析（当前已完整支持 PBG3/PBG4/PBGZ）`);
    }

    const total = parsed.entries.length;
    for (let ei = 0; ei < parsed.entries.length; ei++) {
      const entry = parsed.entries[ei];
      if (entry.empty || entry.size === 0) continue;

      if (ei % 24 === 0) {
        onProgress?.('extract', ei, total, `${fileName} → ${entry.name}`);
        await tick();
      }

      // 按归档类型取出真实内容：PBG3/PBG4 走 LZSS 解压，PBGZ 额外做 edz 头剥离与解密
      const slice = readEntryPayload(buf, entry, parsed, req.gameId) ?? sliceEntry(buf, entry);
      if (slice.length === 0) continue;
      const info = detectMagic(slice);
      const lowerName = entry.name.toLowerCase();

      const looksAnm =
        lowerName.endsWith('.anm') || (!lowerName.includes('.') && parsed.layout !== 'raw-scan' && numSpritesHeuristic(slice) > 0);
      if (looksAnm && modes.images) {
        const handled = await processAnm({
          gameId: req.gameId,
          gid,
          archiveId,
          archiveName: fileName,
          entry,
          slice,
          modes,
          alloc,
          writeResource,
          insertAnimation,
          insertAnimationFrame,
          insertCharacterAsset,
          saveFile,
          spritesDir,
          sheetsDir,
          analysisDir,
          assetsDir,
          characterAgg,
          maxSprites: req.maxSpritesPerAnm ?? 3000,
          summary,
          warnings,
          onProgress: (c, t, m) => onProgress?.('sprites', c, t, m),
        });
        if (handled) continue;
      }

      const cls = classifyEntry({ entryName: entry.name, archiveName: fileName, magic: info });
      const skip =
        (!modes.images && ['sprite', 'image', 'portrait', 'bullet', 'effect', 'background', 'item'].includes(cls.category)) ||
        (!modes.audio && cls.category === 'audio') ||
        (!modes.text && cls.category === 'text') ||
        (!modes.scripts && cls.category === 'script');

      if (skip) {
        writeResource({
          code: alloc.next(cls.category),
          archiveId,
          entryName: entry.name,
          displayName: entry.name,
          ext: path.extname(entry.name) || info.ext,
          kind: cls.kind,
          category: cls.category,
          role: cls.role,
          size: entry.size,
          entryOffset: entry.offset,
          cachePath: null,
          hash: '',
          tags: [...cls.tags, '未导出'],
          meta: { layout: parsed.layout },
        });
        continue;
      }

      let width = 0;
      let height = 0;
      let imageFormat = '';
      let hasAlpha = false;
      let dominantColor = '';
      let colorNames: string[] = [];
      if (info.image && slice.length < 32 * 1024 * 1024) {
        const decoded = decodePng(slice);
        if (decoded) {
          width = decoded.width;
          height = decoded.height;
          imageFormat = 'PNG';
          const colors = analyzeColors(decoded, Math.max(1, Math.floor(Math.sqrt((width * height) / 8192))));
          dominantColor = colors.dominantHex;
          colorNames = colors.names;
          hasAlpha = colors.opaqueRatio < 1;
        }
      }

      const cls2 = classifyEntry({ entryName: entry.name, archiveName: fileName, magic: info, width, height: height || width });
      const code = alloc.next(cls2.category);
      const ext = path.extname(entry.name) || info.ext;
      const subDir = subDirFor(cls2.category, assetsDir);
      const cachePath = saveFile(subDir, `${code}${ext}`, slice);

      const meta: Record<string, unknown> = { archiveLayout: parsed.layout, magic: info.kind, archiveEntry: entry.name };
      let rid = 0;

      // 文本：解析入库（Document 表）
      const isMsgEntry = lowerName.endsWith('.msg') || /^msg\d*\.(dat|msg)$/i.test(lowerName) || /^msg\d+$/i.test(lowerName);
      if (modes.text && isMsgEntry) {
        const msgResult = parseMsg(slice);
        meta.msgLines = msgResult.lines.length;
        meta.msgLayout = msgResult.layout;
        saveFile(analysisDir, `${code}_msg.json`, Buffer.from(JSON.stringify(msgResult, null, 2)));
      }

      rid = writeResource({
        code,
        archiveId,
        entryName: entry.name,
        displayName: entry.name,
        ext,
        kind: cls2.kind,
        category: cls2.category,
        role: cls2.role,
        size: entry.size,
        entryOffset: entry.offset,
        cachePath,
        hash: slice.length < 1024 * 1024 ? md5(slice) : '',
        tags: cls2.tags,
        meta,
        width,
        height,
        imageFormat,
        hasAlpha,
        dominantColor,
        colorNames,
      });

      if (modes.text && isMsgEntry) {
        const msgResult = parseMsg(slice);
        for (const line of msgResult.lines.slice(0, 5000)) {
          insertDialogue.run(gid, rid, extractSpeaker(line.text), line.text, line.time, line.encoding);
        }
        summary.msgLines += Math.min(msgResult.lines.length, 5000);
      }

      // ECL：指令级解析 → BulletPattern + Bullet_Action 时间轴
      const isEclEntry = lowerName.endsWith('.ecl') || /^ecl(data)?$/i.test(lowerName) || lowerName.startsWith('ecldata');
      if (modes.scripts && isEclEntry) {
        const eclResult = parseEcl(slice);
        // Boss 阶段切分（文档第 13 节）
        const phases = analyzeBossPhases(eclResult);
        summary.bossPhases += phases.length;
        meta.ecl = {
          subCount: eclResult.subCount,
          mainOffset: eclResult.mainOffset,
          totalInstructions: eclResult.totalInstructions,
          inference: eclResult.inference,
          phases,
          confidence: eclResult.confidence,
        };
        // 分析 JSON 同时落到磁盘（/api/assets/:id/analysis 读取的是该文件，而非 resource.meta）
        saveFile(analysisDir, `${code}_ecl.json`, Buffer.from(JSON.stringify({ ...eclResult, phases }, null, 2)));
        db.prepare('UPDATE resource SET meta = ? WHERE id = ?').run(JSON.stringify(meta), rid);

        for (const inf of eclResult.inference) {
          const patternCode = `${code}_${inf.kind}`.toUpperCase();
          const pinfo = insertPattern.run({
            code: patternCode,
            gameId: gid,
            resourceId: rid,
            name: `${entry.name} · ${inf.label}`,
            type: inf.kind,
            duration: Number(((eclResult.totalInstructions || 1) / 60).toFixed(2)),
            params: JSON.stringify({
              avgSpeed: inf.avgSpeed,
              avgCount: inf.avgCount,
              angleSpan: inf.angleSpan,
              sampleCount: inf.sampleCount,
              phases,
            }),
            tags: JSON.stringify(['弹幕分析']),
            note: inf.evidence,
            now: nowIso(),
          });
          summary.patterns++;

          // 把每一条携带弹幕参数的指令转成时间轴动作
          const patternId = pinfo.lastInsertRowid as number;
          for (const sub of eclResult.subroutines) {
            for (const ins of sub.instructions) {
              const hit = sub.candidates.find((c) => c.byteOffset >= ins.offset && c.byteOffset < ins.offset + ins.size);
              if (!hit) continue;
              if (hit.opcode !== ins.opcode) continue;
              insertAction.run(
                patternId,
                Number((ins.frame / 60).toFixed(3)),
                'spawn',
                JSON.stringify({
                  count: hit.count,
                  speed: hit.speed,
                  angle: hit.angle,
                  opcode: hit.opcode,
                  subroutine: sub.index,
                  confidence: Number(hit.confidence.toFixed(2)),
                }),
              );
              summary.patternActions++;
            }
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- 角色聚合入库

  onProgress?.('characters', 0, 1, '生成角色与怪物索引');
  let ci = 0;
  for (const [key, agg] of characterAgg) {
    const colors = [...agg.colors.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([c]) => c);
    const type = agg.role === 'boss' ? 'BOSS' : agg.role === 'enemy' ? 'ENEMY' : agg.role === 'player' ? 'PLAYER' : 'OTHER';

    const info = insertCharacter.run(
      gid,
      agg.name,
      null,
      type,
      null,
      agg.sprites,
      agg.animations,
      JSON.stringify(colors),
      agg.source,
      JSON.stringify({ key }),
    );
    const charId = info.lastInsertRowid as number;
    summary.characters++;

    for (const rid of agg.resourceIds) {
      const assetType = agg.role === 'player' ? 'IDLE' : agg.role === 'boss' ? 'SPELL' : 'PORTRAIT';
      insertCharacterAsset.run(charId, rid, assetType);
      summary.characterAssets++;
    }

    if (type === 'ENEMY' || type === 'BOSS') {
      insertEnemy.run(gid, agg.name, type === 'BOSS' ? 'BOSS' : 'FAIRY', null, JSON.stringify({ source: agg.source, sprites: agg.sprites }));
    }
  }

  db.prepare('UPDATE game SET status = ?, extracted_time = ? WHERE id = ?').run('extracted', nowIso(), gid);

  summary.durationMs = Date.now() - started;
  onProgress?.('done', 1, 1, `完成：${summary.assets} 项素材 / ${summary.sprites} 张精灵 / ${summary.animations} 段动画`);
  return summary;
}

// ================================================================ ANM 处理

/** better-sqlite3 预编译语句的最小结构（仅用于传递，避免引入内部类型） */
interface Stmt {
  run: (...args: any[]) => any;
}

interface AnmContext {
  gameId: string;
  gid: number;
  archiveId: number;
  archiveName: string;
  entry: DatEntry;
  slice: Buffer;
  modes: ExtractModes;
  alloc: CodeAllocator;
  writeResource: (a: ResourceInsert) => number;
  insertAnimation: Stmt;
  insertAnimationFrame: Stmt;
  insertCharacterAsset: Stmt;
  saveFile: (dir: string, name: string, data: Buffer) => string;
  spritesDir: string;
  sheetsDir: string;
  analysisDir: string;
  assetsDir: string;
  characterAgg: Map<
    string,
    { name: string; role: string; source: string; sprites: number; animations: number; colors: Map<string, number>; tags: Set<string>; resourceIds: number[] }
  >;
  maxSprites: number;
  summary: ExtractSummary;
  warnings: string[];
  onProgress: (current: number, total: number, message: string) => void;
}

/** 按文件名定位已索引的资源（贴图外置时用它把动画帧指到对应贴图） */
function findResourceByFileName(gid: number, filePath: string | null | undefined): number | null {
  if (!filePath) return null;
  const base = path.basename(filePath.replace(/\\/g, '/'));
  if (!base) return null;
  const row = db.prepare('SELECT id FROM resource WHERE game_id = ? AND filename = ?').get(gid, base) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * 处理 thtk 编译格式的 ANM。
 *
 * 这类版本把贴图**外置**为 PNG（nameoffset 指向路径、thtxoffset 为 0），
 * 因此动画帧无法从 ANM 内部解出，而是直接指向**已提取的同名贴图资源**。
 * 区域表（x/y/w/h）一并保留，供后续按 UV 裁剪还原。
 */
async function processThtkAnm(ctx: AnmContext, thtk: ThtkAnmInfo): Promise<boolean> {
  const base = ctx.entry.name.replace(/\.[^.]*$/, '');
  const cls = classifyEntry({
    entryName: ctx.entry.name,
    archiveName: ctx.archiveName,
    magic: detectMagic(ctx.slice),
    width: thtk.width,
    height: thtk.height,
  });
  const anmCode = ctx.alloc.next(cls.category);

  const anmCachePath = ctx.saveFile(ctx.assetsDir, `${anmCode}.anm`, ctx.slice);
  const anmRid = ctx.writeResource({
    code: anmCode,
    archiveId: ctx.archiveId,
    entryName: ctx.entry.name,
    displayName: `${base} 动画包`,
    ext: '.anm',
    kind: 'anm',
    category: cls.category,
    role: cls.role,
    size: ctx.slice.length,
    entryOffset: ctx.entry.offset,
    cachePath: anmCachePath,
    hash: '',
    tags: [...cls.tags, 'ANM', 'thtk格式', '贴图外置'],
    meta: {
      numSprites: thtk.sprites,
      numScripts: thtk.scripts,
      format: thtk.format,
      version: thtk.version,
      thtxOffset: thtk.thtxOffset,
      externalName: thtk.externalName,
      externalAlphaName: thtk.externalAlphaName,
      regions: thtk.regions,
      notes: ['thtk 编译格式（贴图外置），帧序列关联到已提取的同名贴图'],
    },
  });

  ctx.saveFile(
    ctx.analysisDir,
    `${anmCode}_anm.json`,
    Buffer.from(JSON.stringify({ source: ctx.entry.name, game: ctx.gameId, thtk }, null, 2)),
  );

  // 贴图来源：优先内嵌 THTX 纹理，其次外置 PNG 路径
  const spriteDir = path.join(ctx.spritesDir, safeFileName(base));
  fs.mkdirSync(spriteDir, { recursive: true });

  let frameImgRid = findResourceByFileName(ctx.gid, thtk.externalName) ?? findResourceByFileName(ctx.gid, thtk.externalAlphaName);

  if (thtk.thtxOffset > 0) {
    const tex = parseThtx(ctx.slice, thtk.thtxOffset);
    if (tex) {
      const png = encodePng(tex.image);
      const texCode = ctx.alloc.next(cls.category);
      const texPath = ctx.saveFile(spriteDir, `${base}_tex.png`, png);
      frameImgRid = ctx.writeResource({
        code: texCode,
        archiveId: ctx.archiveId,
        entryName: `${ctx.entry.name}#texture`,
        displayName: `${base} 纹理`,
        ext: '.png',
        kind: 'image',
        category: cls.category === 'unknown' ? 'sprite' : cls.category,
        role: cls.role,
        size: png.length,
        entryOffset: thtk.thtxOffset,
        cachePath: texPath,
        hash: '',
        tags: [...cls.tags, 'ANM纹理', 'THTX'],
        meta: {
          sourceAnm: ctx.entry.name,
          textureFormat: tex.format,
          sourceEncoding: 'thtx',
        },
        width: tex.width,
        height: tex.height,
        imageFormat: 'PNG',
        hasAlpha: true,
      });
    }
  }

  // 贴图缺失（增量包未含原版资源）时生成布局占位图：
  // 把全部精灵区域画到画布上，至少能确认贴图结构与精灵排列密度
  if (!frameImgRid) {
    const cw = Math.min(thtk.width || 256, 1024);
    const chh = Math.min(thtk.height || 256, 1024);
    const canvas = createCanvas(cw, chh, [18, 20, 26, 255]);
    const sx = cw / (thtk.width || cw);
    const sy = chh / (thtk.height || chh);

    for (const r of thtk.regions) {
      const x0 = Math.max(0, Math.round(r.x * sx));
      const y0 = Math.max(0, Math.round(r.y * sy));
      const x1 = Math.min(cw - 1, Math.round((r.x + r.w) * sx) - 1);
      const y1 = Math.min(chh - 1, Math.round((r.y + r.h) * sy) - 1);
      if (x1 < x0 || y1 < y0) continue;
      for (let x = x0; x <= x1; x++) {
        for (const y of [y0, y1]) {
          const o = (y * cw + x) * 4;
          canvas.data[o] = 125; canvas.data[o + 1] = 162; canvas.data[o + 2] = 102; canvas.data[o + 3] = 255;
        }
      }
      for (let y = y0; y <= y1; y++) {
        for (const x of [x0, x1]) {
          const o = (y * cw + x) * 4;
          canvas.data[o] = 125; canvas.data[o + 1] = 162; canvas.data[o + 2] = 102; canvas.data[o + 3] = 255;
        }
      }
    }

    const png = encodePng(canvas);
    const phCode = ctx.alloc.next(cls.category);
    const phPath = ctx.saveFile(spriteDir, `${base}_placeholder.png`, png);
    frameImgRid = ctx.writeResource({
      code: phCode,
      archiveId: ctx.archiveId,
      entryName: `${ctx.entry.name}#placeholder`,
      displayName: `${base} 精灵布局图（贴图缺失占位）`,
      ext: '.png',
      kind: 'image',
      category: cls.category === 'unknown' ? 'sprite' : cls.category,
      role: cls.role,
      size: png.length,
      entryOffset: 0,
      cachePath: phPath,
      hash: '',
      tags: [...cls.tags, '占位图', '贴图缺失'],
      meta: { sourceAnm: ctx.entry.name, placeholder: true, regionCount: thtk.regions.length },
      width: cw,
      height: chh,
      imageFormat: 'PNG',
      hasAlpha: false,
    });
    ctx.warnings.push(
      `${ctx.entry.name}：外置贴图 ${thtk.externalName ?? '(未知)'} 不在本包内（属原版资源），已生成 ${thtk.regions.length} 个精灵区域的布局占位图`,
    );
  }

  if (thtk.regions.length) {
    const info = ctx.insertAnimation.run(
      anmRid,
      `${base}#0`,
      thtk.regions.length,
      8,
      1,
      JSON.stringify({
        source: 'thtk',
        external: thtk.externalName ?? null,
        textureResourceId: frameImgRid,
        regions: thtk.regions,
      }),
    );
    const animId = info.lastInsertRowid as number;
    ctx.summary.animations++;

    thtk.regions.forEach((r, i) => {
      ctx.insertAnimationFrame.run(animId, frameImgRid, i, 8, r.x, r.y, r.w, r.h, 0, 1);
      ctx.summary.animationFrames++;
    });
  }

  return true;
}

async function processAnm(ctx: AnmContext): Promise<boolean> {
  // 优先识别 thtk 编译格式：这类 ANM 的贴图外置为 PNG，
  // 需要走专门的分支把动画帧关联到已提取的贴图上（见 processThtkAnm）
  const thtk = parseThtkAnm(ctx.slice);
  if (thtk && (thtk.externalName || thtk.thtxOffset > 0)) {
    return await processThtkAnm(ctx, thtk);
  }

  const anm = parseAnm(ctx.slice);
  if (!anm || anm.sprites.length === 0) return false;

  const base = ctx.entry.name.replace(/\.[^.]*$/, '');
  const cls = classifyEntry({
    entryName: ctx.entry.name,
    archiveName: ctx.archiveName,
    magic: detectMagic(ctx.slice),
    width: anm.canvasWidth,
    height: anm.canvasHeight,
  });
  const anmCode = ctx.alloc.next(cls.category);

  const anmCachePath = ctx.saveFile(ctx.assetsDir, `${anmCode}.anm`, ctx.slice);
  const anmRid = ctx.writeResource({
    code: anmCode,
    archiveId: ctx.archiveId,
    entryName: ctx.entry.name,
    displayName: `${base} 动画包`,
    ext: '.anm',
    kind: 'anm',
    category: cls.category,
    role: cls.role,
    size: ctx.slice.length,
    entryOffset: ctx.entry.offset,
    cachePath: anmCachePath,
    hash: '',
    tags: [...cls.tags, 'ANM'],
    meta: {
      numSprites: anm.numSprites,
      numScripts: anm.numScripts,
      spriteEntrySize: anm.spriteEntrySize,
      pixelFormat: anm.pixelFormat,
      confidence: anm.confidence,
      notes: anm.notes,
    },
  });

  ctx.saveFile(
    ctx.analysisDir,
    `${anmCode}_anm.json`,
    Buffer.from(
      JSON.stringify(
        {
          source: ctx.entry.name,
          game: ctx.gameId,
          header: {
            numSprites: anm.numSprites,
            numScripts: anm.numScripts,
            canvasWidth: anm.canvasWidth,
            canvasHeight: anm.canvasHeight,
            pixelFormat: anm.pixelFormat,
            spriteEntrySize: anm.spriteEntrySize,
            confidence: anm.confidence,
            notes: anm.notes,
          },
          sprites: anm.sprites.map((s) => ({
            id: s.id,
            width: s.width,
            height: s.height,
            offset: s.offset,
            format: s.format,
            alpha: s.alpha,
            imageKind: s.imageKind,
          })),
          scripts: anm.scripts,
        },
        null,
        2,
      ),
    ),
  );

  const isCharacterLike = ['player', 'enemy', 'boss'].includes(cls.role) || cls.category === 'portrait' || cls.category === 'character';
  const hint = detectCharacterHint(ctx.entry.name, ctx.archiveName);
  let agg: (typeof ctx.characterAgg extends Map<string, infer V> ? V : never) | null = null;
  if (isCharacterLike) {
    const charKey = hint?.key ?? `${base}:${cls.role}`;
    let existing = ctx.characterAgg.get(charKey);
    if (!existing) {
      existing = {
        name: hint?.name ?? defaultCharacterName(base, cls.role, cls.category),
        role: cls.role === 'unknown' ? 'unknown' : cls.role,
        source: `${ctx.archiveName} / ${ctx.entry.name}`,
        sprites: 0,
        animations: anm.scripts.length,
        colors: new Map(),
        tags: new Set(cls.tags),
        resourceIds: [anmRid],
      };
      ctx.characterAgg.set(charKey, existing);
    }
    agg = existing;
  }

  // ---- 提取 sprite
  const sheetFrames: SheetFrame[] = [];
  const spriteRidBySpriteId = new Map<number, number>();
  const limit = Math.min(anm.sprites.length, ctx.maxSprites);
  if (anm.sprites.length > limit) {
    ctx.warnings.push(`${ctx.entry.name} 含 ${anm.sprites.length} 个精灵，本次仅处理前 ${limit} 个`);
  }

  const spriteDir = path.join(ctx.spritesDir, safeFileName(base));
  fs.mkdirSync(spriteDir, { recursive: true });

  let jpegConverted = 0;

  for (let i = 0; i < limit; i++) {
    const sprite = anm.sprites[i];
    if (i % 32 === 0) {
      ctx.onProgress(i, limit, `${ctx.entry.name} 精灵 ${i + 1}/${limit}`);
      await tick();
    }
    const extracted = extractSpriteImage(ctx.slice, sprite);
    if (!extracted) continue;

    const code = ctx.alloc.next(cls.category);

    // 统一解码为 RGBA：PNG 直接解码；JPEG（红魔乡 / 妖妖梦贴图格式）解码后转存 PNG，
    // 并把纯黑背景还原为透明，使其能够参与图集合成。
    const isJpegSprite = extracted.kind === 'jpeg';
    const decoded = extracted.kind === 'png' ? decodePng(extracted.data) : isJpegSprite ? decodeJpeg(extracted.data) : null;

    let outExt = isJpegSprite ? '.jpg' : extracted.kind === 'bmp' ? '.bmp' : '.png';
    let outData = extracted.data;
    let alphaRestored = false;

    if (decoded && isJpegSprite) {
      alphaRestored = applyBlackAsAlpha(decoded);
      outData = encodePng(decoded);
      outExt = '.png';
      jpegConverted++;
    }

    const spriteName = `${base}_${String(sprite.id).padStart(4, '0')}${outExt}`;
    const cachePath = ctx.saveFile(spriteDir, spriteName, outData);

    let width = decoded?.width ?? sprite.width;
    let height = decoded?.height ?? sprite.height;
    let colorNames: string[] = [];
    let dominantColor = '';
    let sheetFrame: SheetFrame | null = null;

    if (decoded) {
      const step = Math.max(1, Math.floor(Math.sqrt((decoded.width * decoded.height) / 4096)));
      const colors = analyzeColors(decoded, step);
      colorNames = colors.names;
      dominantColor = colors.dominantHex;
      for (const n of colors.names.slice(0, 2)) {
        agg?.colors.set(n, (agg.colors.get(n) ?? 0) + 1);
      }
      if (ctx.modes.sheets) sheetFrame = { name: spriteName.replace(/\.[^.]+$/, ''), image: decoded, spriteId: sprite.id };
    }

    const rid = ctx.writeResource({
      code,
      archiveId: ctx.archiveId,
      entryName: `${ctx.entry.name}#${sprite.id}`,
      displayName: spriteName,
      ext: outExt,
      kind: 'image',
      category: cls.category === 'unknown' ? 'sprite' : cls.category,
      role: cls.role,
      size: outData.length,
      entryOffset: sprite.offset,
      cachePath,
      hash: outData.length < 512 * 1024 ? md5(outData) : '',
      tags: [...new Set([...cls.tags, ...colorNames, 'ANM精灵', ...(isJpegSprite && decoded ? ['JPEG转PNG'] : [])])],
      meta: {
        sourceAnm: ctx.entry.name,
        spriteId: sprite.id,
        format: sprite.format,
        alpha: sprite.alpha,
        sourceEncoding: extracted.kind,
        alphaRestored,
        // 碰撞模型（文档第 12 节）：判定框 + 中心 + 半径 + 判定点建议半径
        collision: buildCollision(sprite.alpha, decoded),
      },
      width,
      height,
      imageFormat: 'PNG',
      hasAlpha: alphaRestored,
      dominantColor,
      colorNames,
    });

    spriteRidBySpriteId.set(sprite.id, rid);
    if (agg) {
      agg.sprites++;
      agg.resourceIds.push(rid);
    }
    ctx.summary.sprites++;

    if (sheetFrame) sheetFrames.push(sheetFrame);
  }

  if (jpegConverted > 0) {
    ctx.warnings.push(
      `${ctx.entry.name}：${jpegConverted} 张 JPEG 贴图已转码为 PNG 并还原透明背景（红魔乡 / 妖妖梦的 ANM 以 JPEG 存储贴图）`,
    );
  }

  // ---- Animation / Animation_Frame（把 ANM 脚本还原为动画帧序列）
  for (const script of anm.scripts) {
    const durations = script.frames.map((f) => f.duration || 1);
    const avgDuration = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 1;
    const info = ctx.insertAnimation.run(
      anmRid,
      `${base}#${script.id}`,
      script.frames.length,
      Math.max(1, Math.round(60 / Math.max(1, avgDuration))),
      script.loop ? 1 : 0,
      JSON.stringify({ scriptId: script.id, totalDuration: durations.reduce((a, b) => a + b, 0) }),
    );
    const animId = info.lastInsertRowid as number;
    ctx.summary.animations++;

    script.frames.forEach((f, idx) => {
      ctx.insertAnimationFrame.run(
        animId,
        spriteRidBySpriteId.get(f.spriteId) ?? null,
        idx,
        f.duration || 1,
        0,
        0,
        0,
        1,
      );
      ctx.summary.animationFrames++;
    });
  }

  // ---- Sprite Sheet 生成
  if (ctx.modes.sheets && sheetFrames.length > 0) {
    const sheet = packSheet(sheetFrames, {
      maxWidth: 2048,
      maxHeight: 4096,
      padding: 1,
      gameId: ctx.gameId,
      source: ctx.entry.name,
      nameOf: (f) => f.name,
    });
    if (sheet) {
      const sheetName = `${safeFileName(base)}_sheet.png`;
      const sheetPath = ctx.saveFile(ctx.sheetsDir, sheetName, sheet.png);
      const jsonPath = ctx.saveFile(ctx.sheetsDir, `${safeFileName(base)}_sheet.json`, Buffer.from(JSON.stringify(sheet.json, null, 2)));

      const sheetCode = ctx.alloc.next(cls.category);
      ctx.writeResource({
        code: sheetCode,
        archiveId: ctx.archiveId,
        entryName: `${ctx.entry.name}#sheet`,
        displayName: `${base} 精灵图集`,
        ext: '.png',
        kind: 'image',
        category: 'sheet',
        role: cls.role,
        size: sheet.png.length,
        entryOffset: 0,
        cachePath: sheetPath,
        hash: '',
        tags: [...new Set([...cls.tags, 'SpriteSheet', '可直接导入引擎'])],
        meta: {
          sourceAnm: ctx.entry.name,
          frameCount: sheet.frameCount,
          overflow: sheet.overflow,
          jsonPath,
          jsonName: path.basename(jsonPath),
          atlasSize: { w: sheet.width, h: sheet.height },
        },
        width: sheet.width,
        height: sheet.height,
        imageFormat: 'PNG',
        hasAlpha: true,
      });
      ctx.summary.sheets++;
    }
  }

  return true;
}
