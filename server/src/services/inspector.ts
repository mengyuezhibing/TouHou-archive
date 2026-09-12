import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { parseDat, readEntryPayload, type DatParseResult } from '../formats/dat.ts';
import { detectMagic } from '../core/magic.ts';
import { isThbgm, parseThbgm } from '../formats/bgm.ts';
import { parseAnm } from '../formats/anm.ts';
import { parseEcl } from '../formats/ecl.ts';
import { parseMsg } from '../formats/msg.ts';

/**
 * 归档检视器（对应 UI 设计文档第 6/7 节）。
 *
 * 与解包流水线的区别：**不落盘、不入库**，只把归档的索引与单个条目的内容
 * 按需取出供界面预览，用于解包前的资源踏勘。
 *
 * 解析结果按「路径 + mtime + size」缓存，重复展开同一归档不再重新解析。
 */

interface CacheEntry {
  mtimeMs: number;
  size: number;
  parsed: DatParseResult;
  buf: Buffer;
}

const cache = new Map<string, CacheEntry>();
const MAX_CACHE = 8;

function loadArchive(filePath: string, gameId?: string): CacheEntry | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024 * 1024) return null;

  const hit = cache.get(filePath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;

  const buf = fs.readFileSync(filePath);
  const parsed = parseDat(buf, { gameId: gameId ?? '' });
  const entry: CacheEntry = { mtimeMs: stat.mtimeMs, size: stat.size, parsed, buf };

  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(filePath, entry);
  return entry;
}

/** 按条目名推断分组，供文件树归类显示 */
function groupOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.anm')) return 'animation';
  if (lower.endsWith('.ecl') || /^ecldata/.test(lower)) return 'script';
  if (lower.endsWith('.msg') || /^msg\d*/.test(lower)) return 'text';
  if (lower.endsWith('.std') || lower.endsWith('.sht')) return 'stage';
  if (/\.(png|jpe?g|bmp)$/.test(lower)) return 'image';
  if (/\.(wav|ogg|mp3)$/.test(lower)) return 'audio';
  return 'other';
}

export interface InspectedEntry {
  index: number;
  name: string;
  displayName?: string;
  size: number;
  zsize: number;
  offset: number;
  group: string;
  /** 是否支持内容预览 */
  previewable: boolean;
  extra?: string;
}

export interface InspectResult {
  filePath: string;
  fileName: string;
  layout: string;
  kind: string;
  confidence: number;
  mayBeEncrypted: boolean;
  notes: string[];
  entries: InspectedEntry[];
}

export function inspectArchive(filePath: string, gameId?: string): InspectResult | null {
  const cached = loadArchive(filePath, gameId);
  if (!cached) return null;
  const { parsed, buf } = cached;
  const fileName = path.basename(filePath);

  // BGM 曲目包走独立分支
  if (isThbgm(buf, fileName)) {
    const bgm = parseThbgm(buf);
    return {
      filePath,
      fileName,
      layout: 'thbgm',
      kind: 'bgm',
      confidence: bgm.confidence,
      mayBeEncrypted: false,
      notes: bgm.notes,
      entries: bgm.tracks.map((t, i) => ({
        index: i,
        name: t.fileName,
        displayName: t.title,
        size: t.size,
        zsize: t.size,
        offset: t.offset,
        group: 'audio',
        previewable: false,
        extra: t.codec,
      })),
    };
  }

  return {
    filePath,
    fileName,
    layout: parsed.layout,
    kind: parsed.kind,
    confidence: parsed.confidence,
    mayBeEncrypted: parsed.mayBeEncrypted,
    notes: parsed.notes,
    entries: parsed.entries.map((e) => ({
      index: e.index,
      name: e.name,
      size: e.size,
      zsize: e.zsize ?? e.size,
      offset: e.offset,
      group: groupOf(e.name),
      previewable: e.size > 0 && e.size < 16 * 1024 * 1024,
    })),
  };
}

export interface EntryDetail {
  index: number;
  name: string;
  size: number;
  zsize: number;
  offset: number;
  group: string;
  /** 内容魔数识别结果 */
  magicKind: string;
  magicLabel: string;
  /** 是否为图片，可直接预览 */
  isImage: boolean;
  imageFormat?: string;
  width?: number;
  height?: number;
  /** ANM 结构摘要 */
  anm?: { numSprites: number; numScripts: number; spriteEntrySize: number; pixelFormat: number; imageKinds: Record<string, number> };
  /** ECL 结构摘要 */
  ecl?: { subCount: number; totalInstructions: number; inference: { kind: string; label: string }[] };
  /** MSG 结构摘要 */
  msg?: { lines: number; layout: string; sample: string[] };
  /** 内容前若干字节的十六进制，供人工核对 */
  hexPreview: string;
}

/** 取出单个条目的内容并按类型给出结构摘要 */
export function inspectEntry(filePath: string, index: number, gameId?: string): EntryDetail | null {
  const cached = loadArchive(filePath, gameId);
  if (!cached) return null;
  const { parsed, buf } = cached;
  const target = parsed.entries.find((e) => e.index === index);
  if (!target) return null;

  const data = readEntryPayload(buf, target, parsed, gameId);
  if (!data || data.length === 0) return null;

  const info = detectMagic(data);
  const detail: EntryDetail = {
    index: target.index,
    name: target.name,
    size: target.size,
    zsize: target.zsize ?? target.size,
    offset: target.offset,
    group: groupOf(target.name),
    magicKind: info.kind,
    magicLabel: info.label,
    isImage: info.image,
    hexPreview: data.subarray(0, 48).toString('hex').replace(/(..)/g, '$1 ').trim(),
  };

  const lower = target.name.toLowerCase();

  if (info.kind === 'png') {
    detail.imageFormat = 'PNG';
    // PNG 的宽高位于 IHDR：签名 8 字节 + 长度 4 + 类型 4 = 偏移 16
    if (data.length > 24) {
      detail.width = data.readUInt32BE(16);
      detail.height = data.readUInt32BE(20);
    }
  } else if (info.kind === 'jpeg') {
    detail.imageFormat = 'JPEG';
  } else if (info.kind === 'bmp') {
    detail.imageFormat = 'BMP';
    if (data.length > 26) {
      detail.width = data.readInt32LE(18);
      detail.height = Math.abs(data.readInt32LE(22));
    }
  }

  if (lower.endsWith('.anm') || (!lower.includes('.') && data.length > 0x20 && data.readUInt32LE(0) < 20000)) {
    const anm = parseAnm(data);
    if (anm) {
      const kinds: Record<string, number> = {};
      for (const s of anm.sprites) kinds[s.imageKind] = (kinds[s.imageKind] ?? 0) + 1;
      detail.anm = {
        numSprites: anm.numSprites,
        numScripts: anm.numScripts,
        spriteEntrySize: anm.spriteEntrySize,
        pixelFormat: anm.pixelFormat,
        imageKinds: kinds,
      };
    }
  }

  if (lower.endsWith('.ecl') || /^ecldata/.test(lower)) {
    const ecl = parseEcl(data);
    if (ecl.subCount > 0) {
      detail.ecl = {
        subCount: ecl.subCount,
        totalInstructions: ecl.totalInstructions,
        inference: ecl.inference.map((i) => ({ kind: i.kind, label: i.label })),
      };
    }
  }

  if (lower.endsWith('.msg') || /^msg\d*/.test(lower)) {
    const msg = parseMsg(data);
    if (msg.lines.length) {
      detail.msg = { lines: msg.lines.length, layout: msg.layout, sample: msg.lines.slice(0, 5).map((l) => l.text) };
    }
  }

  return detail;
}

/** 取出条目原始内容（图片用于预览） */
export function extractEntryData(filePath: string, index: number, gameId?: string): { data: Buffer; name: string; entry: InspectedEntry['index'] } | null {
  const cached = loadArchive(filePath, gameId);
  if (!cached) return null;
  const { parsed, buf } = cached;
  const target = parsed.entries.find((e) => e.index === index);
  if (!target) return null;
  const data = readEntryPayload(buf, target, parsed, gameId);
  if (!data) return null;
  return { data, name: target.name, entry: target.index };
}
