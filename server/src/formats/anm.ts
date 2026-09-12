import { Buffer } from 'node:buffer';
import { isPng, type RawImage } from '../core/png.ts';

/**
 * ZUN Engine 精灵动画文件（*.anm）解析器。
 *
 * 布局：
 *   0x00  u32 numSprites
 *   0x04  u32 numScripts
 *   0x08  u32 zero
 *   0x0C  u32 canvasWidth
 *   0x10  u32 canvasHeight
 *   0x14  u32 pixelFormat   1 / 3 / 5 / 7
 *   0x18  u32 zero
 *   0x1C  u32 zero
 *   0x20  Sprite[]    每个条目 32B（红魔乡/妖妖梦）或 36B（永夜抄及之后）
 *   ...   Script[]    动画脚本，帧序列引用 sprite id
 *   ...   图像数据区
 *
 * 由于不同作品条目尺寸存在差异，这里通过**候选尺寸 + 结构自洽性评分**自动判定，
 * 而不是依赖版本号硬编码。
 */

export interface AnmSprite {
  index: number;
  id: number;
  width: number;
  height: number;
  offset: number;
  format: number;
  alpha: { left: number; top: number; right: number; bottom: number };
  dataSize: number;
  imageKind: 'png' | 'jpeg' | 'bmp' | 'raw' | 'unknown';
}

export interface AnmScriptFrame {
  spriteId: number;
  duration: number;
}

export interface AnmScript {
  id: number;
  frames: AnmScriptFrame[];
  totalFrames: number;
  loop: boolean;
}

export interface AnmParseResult {
  spriteEntrySize: number;
  numSprites: number;
  numScripts: number;
  canvasWidth: number;
  canvasHeight: number;
  pixelFormat: number;
  sprites: AnmSprite[];
  scripts: AnmScript[];
  confidence: number;
  notes: string[];
}

const HEADER_SIZE = 0x20;
const SPRITE_ENTRY_CANDIDATES = [32, 36, 28, 44, 48];
const MAX_DIM = 8192;

function u32(buf: Buffer, off: number): number {
  if (off < 0 || off + 4 > buf.length) return -1;
  return buf.readUInt32LE(off);
}

function i16(buf: Buffer, off: number): number {
  if (off < 0 || off + 2 > buf.length) return -1;
  return buf.readInt16LE(off);
}

function f32(buf: Buffer, off: number): number {
  if (off < 0 || off + 4 > buf.length) return -1;
  return buf.readFloatLE(off);
}

interface SpriteProbe {
  entrySize: number;
  sprites: AnmSprite[];
  dataStart: number;
  score: number;
}

function probeSprites(buf: Buffer, numSprites: number, numScripts: number): SpriteProbe | null {
  if (numSprites < 0 || numSprites > 20000) return null;
  if (numScripts < 0 || numScripts > 20000) return null;
  if (numSprites === 0) return null;

  let best: SpriteProbe | null = null;

  for (const entrySize of SPRITE_ENTRY_CANDIDATES) {
    const tableEnd = HEADER_SIZE + numSprites * entrySize;
    if (tableEnd > buf.length) continue;

    const sprites: AnmSprite[] = [];
    let score = 0;
    let ok = true;

    for (let i = 0; i < numSprites; i++) {
      const p = HEADER_SIZE + i * entrySize;
      const id = u32(buf, p);
      const width = u32(buf, p + 4);
      const height = u32(buf, p + 8);
      const offset = u32(buf, p + 12);
      const format = u32(buf, p + 16);

      if (width > MAX_DIM || height > MAX_DIM) {
        ok = false;
        break;
      }
      if (offset < 0 || offset >= buf.length) {
        ok = false;
        break;
      }
      // 数据区必须在表之后
      if (i === 0 && offset + 4 < tableEnd) {
        ok = false;
        break;
      }
      if (id > 65535) {
        ok = false;
        break;
      }
      sprites.push({
        index: i,
        id,
        width,
        height,
        offset,
        format,
        alpha: { left: i16(buf, p + 20), top: i16(buf, p + 22), right: i16(buf, p + 24), bottom: i16(buf, p + 26) },
        dataSize: 0,
        imageKind: 'unknown',
      });
    }

    if (!ok) continue;

    // 偏移递增性
    let ascending = 0;
    for (let i = 1; i < sprites.length; i++) if (sprites[i].offset >= sprites[i - 1].offset) ascending++;
    score += sprites.length > 1 ? ascending / (sprites.length - 1) : 1;

    // 首项 id 通常为 0 或 1
    if (sprites[0].id <= 1) score += 1;
    // 尺寸非零
    const dimOk = sprites.filter((s) => s.width > 0 && s.height > 0).length / sprites.length;
    score += dimOk * 2;
    // 数据区起点 = 表结束附近
    if (Math.abs(sprites[0].offset - tableEnd) < 64) score += 2;
    else if (sprites[0].offset >= tableEnd) score += 1;

    // 图像数据魔数可识别度
    let magicOk = 0;
    for (const s of sprites) {
      const head = buf.subarray(s.offset, Math.min(s.offset + 16, buf.length));
      if (isPng(head) || (head[0] === 0xff && head[1] === 0xd8)) magicOk++;
    }
    score += (magicOk / sprites.length) * 3;

    // 附加条目尺寸应能容纳剩余脚本区
    if (tableEnd <= buf.length) score += 0.5;

    if (!best || score > best.score) {
      best = { entrySize, sprites, dataStart: tableEnd, score };
    }
  }

  if (!best) return null;
  // 计算每个 sprite 的数据长度
  for (let i = 0; i < best.sprites.length; i++) {
    const next = i + 1 < best.sprites.length ? best.sprites[i + 1].offset : buf.length;
    best.sprites[i].dataSize = Math.max(0, next - best.sprites[i].offset);
    const head = buf.subarray(best.sprites[i].offset, Math.min(best.sprites[i].offset + 16, buf.length));
    if (isPng(head)) best.sprites[i].imageKind = 'png';
    else if (head[0] === 0xff && head[1] === 0xd8) best.sprites[i].imageKind = 'jpeg';
    else if (head[0] === 0x42 && head[1] === 0x4d) best.sprites[i].imageKind = 'bmp';
    else best.sprites[i].imageKind = 'raw';
  }
  return best;
}

interface ScriptLayout {
  headSize: number;
  idOffset: number;
  idKind: 'u16' | 'u32';
  countOffset: number;
  frameSize: number;
  score: number;
}

const SCRIPT_LAYOUTS: Array<Omit<ScriptLayout, 'score'>> = [
  { headSize: 16, idOffset: 0, idKind: 'u16', countOffset: 8, frameSize: 8 },
  { headSize: 16, idOffset: 0, idKind: 'u16', countOffset: 8, frameSize: 16 },
  { headSize: 12, idOffset: 0, idKind: 'u16', countOffset: 4, frameSize: 8 },
  { headSize: 16, idOffset: 0, idKind: 'u32', countOffset: 8, frameSize: 8 },
  { headSize: 16, idOffset: 0, idKind: 'u32', countOffset: 8, frameSize: 16 },
  { headSize: 24, idOffset: 0, idKind: 'u32', countOffset: 12, frameSize: 16 },
];

function parseScripts(
  buf: Buffer,
  start: number,
  endBound: number,
  numScripts: number,
  spriteIdSet: Set<number>,
): { scripts: AnmScript[]; layout: ScriptLayout | null } {
  if (numScripts === 0 || start >= buf.length) return { scripts: [], layout: null };
  const limit = Math.min(Math.max(endBound, start), buf.length);

  let best: { scripts: AnmScript[]; layout: ScriptLayout } | null = null;

  for (const layout of SCRIPT_LAYOUTS) {
    let pos = start;
    const scripts: AnmScript[] = [];
    let ok = true;

    for (let s = 0; s < numScripts; s++) {
      if (pos + layout.headSize > limit + 8) {
        ok = false;
        break;
      }
      const id = layout.idKind === 'u16' ? buf.readUInt16LE(pos + layout.idOffset) : u32(buf, pos + layout.idOffset);
      const count = u32(buf, pos + layout.countOffset);
      if (count < 0 || count > 10000) {
        ok = false;
        break;
      }
      const framesEnd = pos + layout.headSize + count * layout.frameSize;
      if (framesEnd > buf.length) {
        ok = false;
        break;
      }
      const frames: AnmScriptFrame[] = [];
      let good = 0;
      for (let f = 0; f < count; f++) {
        const fp = pos + layout.headSize + f * layout.frameSize;
        const spriteId = u32(buf, fp);
        const duration = u32(buf, fp + 4);
        if (spriteIdSet.has(spriteId) && duration <= 100000) good++;
        frames.push({ spriteId, duration });
      }
      // 允许少量异常帧（脚本中存在空帧/占位）
      if (count > 0 && good / count < 0.8) {
        ok = false;
        break;
      }
      scripts.push({ id, frames, totalFrames: frames.length, loop: false });
      pos = framesEnd;
    }

    if (!ok || scripts.length === 0) continue;

    // 走完后应基本贴合图像数据区起点（允许尾部对齐填充）
    let score = 1;
    const tail = limit - pos;
    if (tail >= -8 && tail <= 64) score += 3;
    else if (tail >= -8 && tail <= 512) score += 1.5;
    if (scripts[0].id <= 1) score += 1;
    const totalFrames = scripts.reduce((a, s) => a + s.totalFrames, 0);
    if (totalFrames > 0) score += 1;

    if (!best || score > best.layout.score) {
      best = { scripts, layout: { ...layout, score } };
    }
  }

  if (!best) return { scripts: [], layout: null };
  // 第二个脚本若引用同一 sprite 序列，视作循环
  for (const sc of best.scripts) {
    sc.loop = sc.frames.length > 1 && sc.frames[0].spriteId === sc.frames[sc.frames.length - 1].spriteId;
  }
  return best;
}

export function isAnm(buf: Buffer): boolean {
  if (buf.length < HEADER_SIZE) return false;
  const numSprites = u32(buf, 0);
  const numScripts = u32(buf, 4);
  if (numSprites < 1 || numSprites > 20000) return false;
  if (numScripts > 20000) return false;
  const probe = probeSprites(buf, numSprites, numScripts);
  return !!probe && probe.score >= 3;
}

/** 读取 NUL 结尾字符串 */
function readCString(buf: Buffer, offset: number, max = 200): string | null {
  if (offset <= 0 || offset >= buf.length) return null;
  let end = offset;
  while (end < buf.length && buf[end] !== 0 && end - offset < max) end++;
  if (end === offset) return null;
  const s = buf.toString('latin1', offset, end);
  return /^[\x20-\x7e]{2,}$/.test(s) ? s : null;
}

/**
 * thtk 编译格式的 ANM（汉化 / 重打包版本常见）。
 *
 * 依据 thtk 的 `anm_header06_t`（**64 字节**，与原始 ZUN 的 32 字节头不同）：
 *   0x00 sprites      0x04 scripts      0x08 rt_textureslot
 *   0x0C w            0x10 h            0x14 format
 *   0x18 colorkey     0x1C nameoffset   0x20 x
 *   0x24 y(=第二名称偏移) 0x28 version      0x2C memorypriority
 *   0x30 thtxoffset   0x34 hasdata(u16) 0x36 lowresscale(u16)
 *   0x38 nextoffset   0x3C zero3
 *  0x40 起为 sprite 区域偏移表（每项 u32，指向 20 字节的区域数据）
 *
 * 这类版本通常把贴图**外置**为 PNG（nameoffset 指向路径、thtxoffset 为 0），
 * 因此这里解析出结构，同时把外置文件名一并返回，供上层关联已提取的贴图。
 */
export interface ThtkAnmInfo {
  sprites: number;
  scripts: number;
  width: number;
  height: number;
  format: number;
  version: number;
  thtxOffset: number;
  externalName: string | null;
  externalAlphaName: string | null;
  /** 区域数据为 20 字节：{id: u32, x: f32, y: f32, w: f32, h: f32} */
  regions: Array<{ index: number; id: number; x: number; y: number; w: number; h: number }>;
}

export function parseThtkAnm(buf: Buffer): ThtkAnmInfo | null {
  if (buf.length < 64) return null;

  const sprites = u32(buf, 0);
  const scripts = u32(buf, 4);
  const width = u32(buf, 12);
  const height = u32(buf, 16);
  const format = u32(buf, 20);
  const nameOffset = u32(buf, 28);
  const alphaNameOffset = u32(buf, 36);
  const version = u32(buf, 40);
  const thtxOffset = u32(buf, 48);

  // 严格校验：TH06 的 version 必须为 0，尺寸与像素格式需落在合法范围
  if (version !== 0) return null;
  if (sprites < 1 || sprites > 20000) return null;
  if (width < 1 || width > 8192 || height < 1 || height > 8192) return null;
  if (![1, 3, 5, 7].includes(format)) return null;
  if (nameOffset === 0 && thtxOffset === 0) return null;

  // 区域偏移表：0x40 起，每项 u32
  const tableEnd = 64 + sprites * 4;
  if (tableEnd > buf.length) return null;

  const regions: ThtkAnmInfo['regions'] = [];
  for (let i = 0; i < sprites; i++) {
    const off = u32(buf, 64 + i * 4);
    if (off <= 0 || off + 20 > buf.length) return null;
    regions.push({
      index: i,
      id: u32(buf, off),
      x: f32(buf, off + 4),
      y: f32(buf, off + 8),
      w: f32(buf, off + 12),
      h: f32(buf, off + 16),
    });
  }

  return {
    sprites,
    scripts,
    width,
    height,
    format,
    version,
    thtxOffset,
    externalName: readCString(buf, nameOffset),
    externalAlphaName: readCString(buf, alphaNameOffset),
    regions,
  };
}

/**
 * THTX 内嵌纹理块（thtxoffset 指向处）。
 *
 * 头 16 字节：magic "THTX" / zero(u16) / format(u16) / w(u16) / h(u16) / size(u32)
 * 其后为 size 字节的原始像素数据。
 *
 * 像素格式（值与 anm header 的 format 一致）：
 *   1 = BGRA8888（4B/px）
 *   3 = RGB565（2B/px，注意 R 在低 5 位、B 在高 5 位）
 *   5 = ARGB4444（2B/px，位15-12=A、11-8=R、7-4=G、3-0=B）
 *   7 = GRAY8（1B/px）
 */
export interface ThtxTexture {
  format: number;
  width: number;
  height: number;
  image: RawImage;
}

export function parseThtx(buf: Buffer, offset: number): ThtxTexture | null {
  if (offset < 0 || offset + 16 > buf.length) return null;
  if (buf.toString('latin1', offset, offset + 4) !== 'THTX') return null;

  const format = buf.readUInt16LE(offset + 6);
  const width = buf.readUInt16LE(offset + 8);
  const height = buf.readUInt16LE(offset + 10);
  const size = buf.readUInt32LE(offset + 12);
  if (width < 1 || width > 8192 || height < 1 || height > 8192) return null;

  const bpp = format === 1 ? 4 : format === 7 ? 1 : 2;
  const dataStart = offset + 16;
  const data = buf.subarray(dataStart, Math.min(dataStart + size, buf.length));

  const image: RawImage = { width, height, data: Buffer.alloc(width * height * 4) };
  const px = Math.min(width * height, Math.floor(data.length / bpp));

  for (let i = 0; i < px; i++) {
    const o = i * 4;
    if (format === 1) {
      // BGRA8888 → RGBA
      image.data[o + 0] = data[i * 4 + 2];
      image.data[o + 1] = data[i * 4 + 1];
      image.data[o + 2] = data[i * 4 + 0];
      image.data[o + 3] = data[i * 4 + 3];
    } else if (format === 3) {
      // RGB565：位4-0=R、9-5=G、14-10=B（位扩展到 8 位）
      const v = data.readUInt16LE(i * 2);
      const r5 = v & 0x1f;
      const g6 = (v >> 5) & 0x3f;
      const b5 = (v >> 11) & 0x1f;
      image.data[o + 0] = (r5 << 3) | (r5 >> 2);
      image.data[o + 1] = (g6 << 2) | (g6 >> 4);
      image.data[o + 2] = (b5 << 3) | (b5 >> 2);
      image.data[o + 3] = 255;
    } else if (format === 5) {
      // ARGB4444：位15-12=A、11-8=R、7-4=G、3-0=B（×17 位扩展）
      const v = data.readUInt16LE(i * 2);
      image.data[o + 0] = ((v >> 8) & 0x0f) * 17;
      image.data[o + 1] = ((v >> 4) & 0x0f) * 17;
      image.data[o + 2] = (v & 0x0f) * 17;
      image.data[o + 3] = ((v >> 12) & 0x0f) * 17;
    } else if (format === 7) {
      image.data[o + 0] = image.data[o + 1] = image.data[o + 2] = data[i];
      image.data[o + 3] = 255;
    }
  }

  return { format, width, height, image };
}

export function parseAnm(buf: Buffer): AnmParseResult | null {
  if (buf.length < HEADER_SIZE) return null;
  const numSprites = u32(buf, 0);
  const numScripts = u32(buf, 4);
  const canvasWidth = u32(buf, 12);
  const canvasHeight = u32(buf, 16);
  const pixelFormat = u32(buf, 20);

  const probe = probeSprites(buf, numSprites, numScripts);
  if (!probe) return null;

  const spriteIdSet = new Set(probe.sprites.map((s) => s.id));
  const scriptsEnd = Math.min(...probe.sprites.map((s) => s.offset));
  const { scripts } = parseScripts(buf, probe.dataStart, Math.max(scriptsEnd, probe.dataStart), numScripts, spriteIdSet);

  const notes: string[] = [`Sprite 条目尺寸 ${probe.entrySize}B`];
  if (scripts.length > 0) notes.push(`成功解析 ${scripts.length} 条动画脚本`);
  else if (numScripts > 0) notes.push(`声明 ${numScripts} 条动画脚本，但结构未通过自洽校验`);

  const imageStats = { png: 0, jpeg: 0, bmp: 0, raw: 0 };
  for (const s of probe.sprites) imageStats[s.imageKind === 'unknown' ? 'raw' : s.imageKind]++;
  notes.push(`贴图格式：PNG ${imageStats.png} / JPEG ${imageStats.jpeg} / BMP ${imageStats.bmp} / 原始像素 ${imageStats.raw}`);

  return {
    spriteEntrySize: probe.entrySize,
    numSprites,
    numScripts: scripts.length,
    canvasWidth: canvasWidth > 0 && canvasWidth <= MAX_DIM * 4 ? canvasWidth : 0,
    canvasHeight: canvasHeight > 0 && canvasHeight <= MAX_DIM * 4 ? canvasHeight : 0,
    pixelFormat,
    sprites: probe.sprites,
    scripts,
    confidence: Math.min(1, probe.score / 8),
    notes,
  };
}

/** 提取单个 sprite 的内嵌图片数据（若为 PNG/JPEG/BMP 直接返回原始字节） */
export function extractSpriteImage(buf: Buffer, sprite: AnmSprite): { data: Buffer; kind: string } | null {
  const start = sprite.offset;
  const end = Math.min(buf.length, sprite.offset + sprite.dataSize);
  if (start >= end) return null;
  const slice = buf.subarray(start, end);
  if (isPng(slice)) return { data: Buffer.from(slice), kind: 'png' };
  if (slice[0] === 0xff && slice[1] === 0xd8) return { data: Buffer.from(slice), kind: 'jpeg' };
  if (slice[0] === 0x42 && slice[1] === 0x4d) return { data: Buffer.from(slice), kind: 'bmp' };
  return null;
}
