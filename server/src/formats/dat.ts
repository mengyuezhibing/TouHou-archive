import { Buffer } from 'node:buffer';
import { BinaryReader, looksLikeFilename } from '../core/binary.ts';
import { detectMagic, type MagicInfo } from '../core/magic.ts';
import { BitReader } from '../core/bitstream.ts';
import { lzssDecompress } from '../core/lzss.ts';
import {
  thDecrypt,
  TH08_CRYPT_PARAMS,
  TH09_CRYPT_PARAMS,
  paramsByTypeChar,
  type CryptParams,
  type TypedCryptParams,
} from '../core/crypt.ts';

/**
 * ZUN Engine 归档（*.dat）解析器。
 *
 * 依据 thtk（Touhou Toolkit，社区事实标准实现）的格式规范，按魔数分派：
 *
 *   PBG3 (TH06)  极简头 + **位流编码的变长整数条目表**，数据 LZSS 压缩
 *   PBG4 (TH07)  定长头 + LZSS 压缩的扁平索引表，数据 LZSS 压缩
 *   PBGZ (TH08/09) 混淆头 + 位于**文件末尾**的加密压缩索引表，
 *                  每个条目内含 "edz"+类型码，载荷按类型参数解密
 *
 * 对于未匹配到已知魔数的归档（TH10+ 多数使用带加密的表结构），
 * 保留原有的**多布局自适应探测**与**魔数扫描**兜底，并在结果中标注数据是否可能经过加密。
 */

export interface DatEntry {
  index: number;
  name: string;
  /** 数据在文件中的绝对偏移 */
  offset: number;
  /** 解压后大小（PBG3/PBG4/PBGZ）或原始切片长度（兜底模式） */
  size: number;
  /** 压缩数据在文件中的实际长度 */
  zsize?: number;
  /** PBG3 的压缩数据校验和 */
  checksum?: number;
  /** PBGZ 的条目类型码（'M'/'A'/'E' 等） */
  typeChar?: string;
  magic: MagicInfo;
  empty: boolean;
}

export type ArchiveKind = 'pbg3' | 'pbg4' | 'pbgz' | 'probed' | 'raw-scan';

export interface DatParseResult {
  layout: string;
  kind: ArchiveKind;
  confidence: number;
  declaredCount: number;
  entries: DatEntry[];
  dataOffset: number;
  /** 数据是否可能被加密（未支持的版本会置位，界面据此提示） */
  mayBeEncrypted: boolean;
  notes: string[];
}

const MAX_ENTRIES = 100000;

// ================================================================ PBG3 (TH06)

function parsePbg3(buf: Buffer): DatParseResult | null {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'PBG3') return null;

  const br = new BitReader(buf, 4);
  const entryCount = br.readVariableUInt();
  const tableOffset = br.readVariableUInt();

  if (entryCount < 1 || entryCount > MAX_ENTRIES) return null;
  if (tableOffset < 8 || tableOffset >= buf.length) return null;

  br.seekByte(tableOffset);
  const raw: Array<{ name: string; offset: number; size: number; checksum: number }> = [];

  for (let i = 0; i < entryCount; i++) {
    if (br.byteCount > buf.length) break;
    br.readVariableUInt(); // unknown1（归档内恒定）
    br.readVariableUInt(); // unknown2
    const checksum = br.readVariableUInt();
    const offset = br.readVariableUInt();
    const size = br.readVariableUInt();
    const name = br.readCString(255);
    if (!name) break;
    raw.push({ name, offset, size, checksum });
  }

  if (raw.length === 0) return null;

  // 压缩长度由相邻条目的偏移差推导，末项到索引表起点为止
  const sorted = [...raw].sort((a, b) => a.offset - b.offset);
  const sizeByOffset = new Map<number, number>();
  for (let i = 0; i < sorted.length; i++) {
    const next = i + 1 < sorted.length ? sorted[i + 1].offset : tableOffset;
    sizeByOffset.set(sorted[i].offset, Math.max(0, next - sorted[i].offset));
  }

  const entries: DatEntry[] = raw.map((r, i) => {
    const zsize = sizeByOffset.get(r.offset) ?? 0;
    const head = readPreview(buf, r.offset, zsize);
    return {
      index: i,
      name: r.name,
      offset: r.offset,
      size: r.size,
      zsize,
      checksum: r.checksum,
      magic: detectMagic(head),
      empty: r.size === 0,
    };
  });

  return {
    layout: 'PBG3',
    kind: 'pbg3',
    confidence: 0.98,
    declaredCount: entryCount,
    entries,
    dataOffset: 13,
    mayBeEncrypted: false,
    notes: [
      `PBG3（红魔乡）：位流索引表位于 0x${tableOffset.toString(16).toUpperCase()}，共 ${entries.length}/${entryCount} 条`,
      '条目数据为 LZSS 压缩（窗口 8192 / 最小匹配 3 / 偏移 13 位 / 长度 4 位）',
    ],
  };
}

// ================================================================ PBG4 (TH07)

function parsePbg4(buf: Buffer): DatParseResult | null {
  if (buf.length < 16 || buf.toString('latin1', 0, 4) !== 'PBG4') return null;

  const count = buf.readUInt32LE(4);
  const tableOffset = buf.readUInt32LE(8);
  if (count < 1 || count > MAX_ENTRIES) return null;
  if (tableOffset < 16 || tableOffset >= buf.length) return null;

  const maxOut = Math.min(buf.length * 2 + 65536, 128 * 1024 * 1024);
  const table = lzssDecompress(buf, maxOut, tableOffset);
  if (table.length < 16) return null;

  const raw: Array<{ name: string; offset: number; size: number }> = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    const nul = table.indexOf(0, p);
    if (nul === -1) break;
    const name = table.toString('latin1', p, nul);
    p = nul + 1;
    if (p + 12 > table.length) break;
    const offset = table.readUInt32LE(p);
    const size = table.readUInt32LE(p + 4);
    p += 12; // offset + size + extra
    if (!looksLikeFilename(name)) break;
    raw.push({ name, offset, size });
  }

  if (raw.length === 0) return null;

  const sorted = [...raw].sort((a, b) => a.offset - b.offset);
  const sizeByOffset = new Map<number, number>();
  for (let i = 0; i < sorted.length; i++) {
    const next = i + 1 < sorted.length ? sorted[i + 1].offset : tableOffset;
    sizeByOffset.set(sorted[i].offset, Math.max(0, next - sorted[i].offset));
  }

  const entries: DatEntry[] = raw.map((r, i) => ({
    index: i,
    name: r.name,
    offset: r.offset,
    size: r.size,
    zsize: sizeByOffset.get(r.offset) ?? 0,
    magic: detectMagic(readPreview(buf, r.offset, sizeByOffset.get(r.offset) ?? 0)),
    empty: r.size === 0,
  }));

  return {
    layout: 'PBG4',
    kind: 'pbg4',
    confidence: 0.98,
    declaredCount: count,
    entries,
    dataOffset: 16,
    mayBeEncrypted: false,
    notes: [
      `PBG4（妖妖梦）：索引表经 LZSS 压缩后位于 0x${tableOffset.toString(16).toUpperCase()}，解析出 ${entries.length}/${count} 条`,
      '条目数据为 LZSS 压缩',
    ],
  };
}

// ================================================================ PBGZ (TH08/TH09)

function parsePbgz(buf: Buffer, gameId: string): DatParseResult | null {
  if (buf.length < 32 || buf.toString('latin1', 0, 4) !== 'PBGZ') return null;

  // 仅魔数之后的 12 字节参与解密
  const header = Buffer.from(buf.subarray(4, 16));
  thDecrypt(header, { key: 0x1b, step: 0x37, block: 12, limit: 0x400 });

  const count = header.readUInt32LE(0) - 123456;
  const tableOffset = header.readUInt32LE(4) - 345678;
  const tableSize = header.readUInt32LE(8) - 567891;

  if (count < 1 || count > MAX_ENTRIES) return null;
  if (tableOffset < 16 || tableOffset >= buf.length) return null;

  const zdata = Buffer.from(buf.subarray(tableOffset));
  thDecrypt(zdata, { key: 0x3e, step: 0x9b, block: 0x80, limit: 0x400 });

  const maxOut = Math.min(Math.max(tableSize, 4096) * 4 + 65536, 128 * 1024 * 1024);
  const table = lzssDecompress(zdata, maxOut, 0);
  if (table.length < 16) return null;

  const raw: Array<{ name: string; offset: number; size: number }> = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    const nul = table.indexOf(0, p);
    if (nul === -1) break;
    const name = table.toString('latin1', p, nul);
    p = nul + 1;
    if (p + 12 > table.length) break;
    const offset = table.readUInt32LE(p);
    const size = table.readUInt32LE(p + 4);
    p += 12;
    if (!name) break;
    raw.push({ name, offset, size });
  }

  if (raw.length === 0) return null;

  const sorted = [...raw].sort((a, b) => a.offset - b.offset);
  const sizeByOffset = new Map<number, number>();
  for (let i = 0; i < sorted.length; i++) {
    const next = i + 1 < sorted.length ? sorted[i + 1].offset : tableOffset;
    sizeByOffset.set(sorted[i].offset, Math.max(0, next - sorted[i].offset));
  }

  const entries: DatEntry[] = raw.map((r, i) => ({
    index: i,
    name: r.name,
    offset: r.offset,
    size: r.size,
    zsize: sizeByOffset.get(r.offset) ?? 0,
    magic: { kind: 'binary', ext: '.bin', mime: 'application/octet-stream', label: '加密载荷（edz）', image: false, audio: false, text: false },
    empty: r.size <= 4,
  }));

  const ver = gameId === 'TH09' ? 'TH09' : 'TH08';
  return {
    layout: 'PBGZ',
    kind: 'pbgz',
    confidence: 0.97,
    declaredCount: count,
    entries,
    dataOffset: 16,
    mayBeEncrypted: true,
    notes: [
      `PBGZ（${ver === 'TH09' ? '花映塚' : '永夜抄'}）：条目表位于文件末尾 0x${tableOffset.toString(16).toUpperCase()}，解出 ${entries.length}/${count} 条`,
      '条目载荷先经 LZSS 解压，再按 "edz" 头中的类型码用对应参数解密',
    ],
  };
}

// ================================================================ 兜底：自适应探测

interface Probe {
  layout: string;
  count: number;
  dataOffset: number;
  names: string[];
  offsets: number[];
  sizes?: number[];
  notes: string[];
}

function probeFixedNameTable(buf: Buffer): Probe | null {
  if (buf.length < 32) return null;
  const count = buf.readUInt32LE(0);
  const dataOffset = buf.readUInt32LE(4);
  const tableOffset = buf.readUInt32LE(8);
  if (count < 1 || count > MAX_ENTRIES) return null;
  if (dataOffset < 16 || dataOffset >= buf.length) return null;
  if (Math.abs(tableOffset - (16 + count * 16)) > 16) return null;

  const names: string[] = [];
  const r = new BinaryReader(buf, 16);
  for (let i = 0; i < count; i++) {
    if (r.remaining < 16) return null;
    const s = r.fixedString(16);
    if (!s || !looksLikeFilename(s)) return null;
    names.push(s);
  }
  const tablePos = 16 + count * 16;

  if (tablePos + count * 8 <= buf.length) {
    const sizes: number[] = [];
    const offsets: number[] = [];
    for (let i = 0; i < count; i++) {
      sizes.push(buf.readUInt32LE(tablePos + i * 8));
      offsets.push(buf.readUInt32LE(tablePos + i * 8 + 4));
    }
    if (offsets.every((o) => o >= 0 && dataOffset + o <= buf.length)) {
      return { layout: 'fixed-name-16/size+offset-pairs', count, dataOffset, names, offsets, sizes, notes: ['16 字节定长名 + (size,offset) 交错表'] };
    }
  }
  return null;
}

function probeVariableNameTable(buf: Buffer): Probe | null {
  if (buf.length < 12) return null;
  const count = buf.readUInt32LE(0);
  const dataOffset = buf.readUInt32LE(4);
  if (count < 1 || count > MAX_ENTRIES) return null;
  if (dataOffset < 8 || dataOffset >= buf.length) return null;

  const r = new BinaryReader(buf, 8);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    if (r.remaining < 2) return null;
    const before = r.pos;
    const s = r.cstring(80);
    if (r.pos - before > 80) return null;
    if (!looksLikeFilename(s)) return null;
    names.push(s);
  }
  if (r.pos + count * 4 > buf.length) return null;
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push(buf.readUInt32LE(r.pos + i * 4));
  return { layout: 'variable-name/offsets', count, dataOffset, names, offsets, notes: ['变长 NUL 名 + 偏移表'] };
}

function buildProbedEntries(buf: Buffer, probe: Probe, relative: boolean): { entries: DatEntry[]; score: number } {
  const { names, offsets, dataOffset, sizes } = probe;
  const count = names.length;
  const base = relative ? dataOffset : 0;
  const abs = offsets.map((o) => base + o);

  let valid = 0;
  let ascending = 0;
  for (let i = 0; i < count; i++) {
    if (abs[i] >= 0 && abs[i] <= buf.length) valid++;
    if (i > 0 && abs[i] >= abs[i - 1]) ascending++;
  }

  let score = 3;
  if (valid === count) score += 3;
  if (count > 1 && ascending / (count - 1) > 0.98) score += 2;
  if (Math.abs(abs[0] - dataOffset) <= 4) score += 2;

  const entries: DatEntry[] = [];
  for (let i = 0; i < count; i++) {
    const start = abs[i];
    if (start < 0 || start > buf.length) continue;
    let size = 0;
    if (sizes && sizes[i] > 0 && start + sizes[i] <= buf.length) size = sizes[i];
    else if (i + 1 < count) size = abs[i + 1] - start;
    else size = buf.length - start;
    if (size <= 0) {
      entries.push({ index: i, name: names[i], offset: start, size: 0, magic: detectMagic(Buffer.alloc(0)), empty: true });
      continue;
    }
    entries.push({
      index: i,
      name: names[i],
      offset: start,
      size,
      zsize: size,
      magic: detectMagic(buf.subarray(start, Math.min(start + 512, start + size))),
      empty: false,
    });
  }

  const recognizable = entries.filter((e) => !e.empty && e.magic.kind !== 'binary').length;
  if (recognizable > 0) score += Math.min(3, recognizable);
  return { entries, score };
}

/** 魔数扫描兜底：任何文件都能提出可识别的资源 */
function rawScan(buf: Buffer): DatEntry[] {
  const patterns: Array<{ sig: Buffer; ext: string }> = [
    { sig: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ext: '.png' },
    { sig: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), ext: '.jpg' },
    { sig: Buffer.from([0xff, 0xd8, 0xff, 0xe1]), ext: '.jpg' },
    { sig: Buffer.from([0xff, 0xd8, 0xff, 0xdb]), ext: '.jpg' },
    { sig: Buffer.from('OggS', 'latin1'), ext: '.ogg' },
    { sig: Buffer.from('RIFF', 'latin1'), ext: '.wav' },
    { sig: Buffer.from('BM', 'latin1'), ext: '.bmp' },
    { sig: Buffer.from('edz', 'latin1'), ext: '.bin' },
  ];

  const hits: Array<{ offset: number; ext: string }> = [];
  for (const { sig, ext } of patterns) {
    let idx = 0;
    while (idx <= buf.length - sig.length) {
      const found = buf.indexOf(sig, idx);
      if (found === -1) break;
      hits.push({ offset: found, ext });
      idx = found + 1;
      if (hits.length > 200000) break;
    }
  }

  hits.sort((a, b) => a.offset - b.offset);
  const entries: DatEntry[] = [];
  const seen: Array<{ offset: number; ext: string }> = [];
  for (const hit of hits) {
    if (seen.length && hit.offset - seen[seen.length - 1].offset < 32) continue;
    seen.push(hit);
  }
  seen.forEach((hit, i) => {
    const next = i + 1 < seen.length ? seen[i + 1].offset : buf.length;
    entries.push({
      index: i,
      name: `raw_${String(i + 1).padStart(4, '0')}${hit.ext}`,
      offset: hit.offset,
      size: next - hit.offset,
      zsize: next - hit.offset,
      magic: detectMagic(buf.subarray(hit.offset, Math.min(hit.offset + 512, buf.length))),
      empty: false,
    });
  });
  return entries;
}

// ================================================================ 主入口

export function parseDat(buf: Buffer, options: { gameId?: string; forceRawScan?: boolean } = {}): DatParseResult {
  const gameId = (options.gameId ?? '').toUpperCase();
  const notes: string[] = [];

  if (!options.forceRawScan) {
    const pbg3 = safe(() => parsePbg3(buf));
    if (pbg3) return pbg3;

    const pbg4 = safe(() => parsePbg4(buf));
    if (pbg4) return pbg4;

    const pbgz = safe(() => parsePbgz(buf, gameId));
    if (pbgz) return pbgz;

    // 未知魔数：尝试通用布局探测
    for (const probe of [safe(() => probeFixedNameTable(buf)), safe(() => probeVariableNameTable(buf))]) {
      if (!probe) continue;
      let best: { entries: DatEntry[]; score: number; relative: boolean } | null = null;
      for (const relative of [true, false]) {
        const r = safe(() => buildProbedEntries(buf, probe, relative));
        if (!r || r.entries.length === 0) continue;
        if (!best || r.score > best.score) best = { ...r, relative };
      }
      if (best && best.score >= 8) {
        return {
          layout: probe.layout,
          kind: 'probed',
          confidence: Math.min(1, best.score / 14),
          declaredCount: probe.count,
          entries: best.entries,
          dataOffset: probe.dataOffset,
          mayBeEncrypted: true,
          notes: [
            ...probe.notes,
            `未匹配到 PBG3/PBG4/PBGZ 魔数，使用通用布局探测（偏移基准：${best.relative ? '相对数据区' : '绝对'}）`,
            '该版本归档（风神录及之后）通常对条目数据做了加密，提取出的内容可能需要解密后才能解析',
          ],
        };
      }
    }
    notes.push('未匹配到已知归档魔数，已回退到魔数扫描模式');
  } else {
    notes.push('强制魔数扫描模式');
  }

  const entries = rawScan(buf);
  return {
    layout: 'raw-scan',
    kind: 'raw-scan',
    confidence: entries.length > 0 ? 0.4 : 0,
    declaredCount: entries.length,
    entries,
    dataOffset: 0,
    mayBeEncrypted: false,
    notes,
  };
}

/**
 * 取出条目的**实际内容**。
 * PBG3/PBG4 需 LZSS 解压；PBGZ 需 LZSS 解压 + 跳过 edz 头 + 按类型解密；
 * 兜底模式直接切片。
 */
export function readEntryPayload(buf: Buffer, entry: DatEntry, result: DatParseResult, gameId?: string): Buffer | null {
  try {
    switch (result.kind) {
      case 'pbg3':
      case 'pbg4': {
        if (entry.size <= 0) return null;
        const raw = lzssDecompress(buf, entry.size, entry.offset);
        /**
         * 新版重制（如东方红魔乡 New Classic）会在条目载荷外再包一层 edz 头。
         * 这一段原本只写在 PBGZ 分支里，于是新版里经 edz 封装的 ECL / 音频
         * 全部落到「无法识别的二进制」，表现为解包后只有图片、没有脚本与声音。
         * 这里对 LZSS 解压结果统一检查一次 edz，让新旧两套封装都能还原。
         */
        if (raw.length >= 4 && raw.toString('latin1', 0, 3) === 'edz') {
          const typeChar = String.fromCharCode(raw[3]);
          entry.typeChar = typeChar;
          const payload = Buffer.from(raw.subarray(4));
          const table =
            (gameId ?? '').toUpperCase() === 'TH09' ? TH09_CRYPT_PARAMS : TH08_CRYPT_PARAMS;
          const params = paramsByTypeChar(table, typeChar);
          // 类型码命中旧参数表才解密。重制版的类型码不在旧表里，
          // 此时只剥头不解密 —— 至少能露出真实魔数，交给后续识别判断。
          if (params) thDecrypt(payload, params as CryptParams);
          return payload;
        }
        return raw;
      }

      case 'pbgz': {
        const zsize = entry.zsize ?? entry.size;
        if (zsize <= 0 || entry.size <= 0) return null;
        const compressed = Buffer.from(buf.subarray(entry.offset, Math.min(entry.offset + zsize, buf.length)));
        const raw = lzssDecompress(compressed, entry.size, 0);
        if (raw.length < 4) return raw;
        if (raw.toString('latin1', 0, 3) !== 'edz') return raw;
        const typeChar = String.fromCharCode(raw[3]);
        entry.typeChar = typeChar;
        const table: TypedCryptParams[] = (gameId ?? '').toUpperCase() === 'TH09' ? TH09_CRYPT_PARAMS : TH08_CRYPT_PARAMS;
        const params = paramsByTypeChar(table, typeChar);
        const payload = Buffer.from(raw.subarray(4));
        if (params) thDecrypt(payload, params as CryptParams);
        return payload;
      }

      default: {
        const raw = sliceEntry(buf, entry);
        /**
         * raw-scan 兜底模式下，新版重制的条目同样可能带 edz 头。
         * 即便没有解密参数，至少把头剥掉、让真实魔数露出来 ——
         * 有些 edz 条目可能只是「头 + 原始数据」而不加密。
         */
        if (raw.length >= 4 && raw.toString('latin1', 0, 3) === 'edz') {
          entry.typeChar = String.fromCharCode(raw[3]);
          return Buffer.from(raw.subarray(4));
        }
        return raw;
      }
    }
  } catch {
    return null;
  }
}

/** 简单切片（兜底模式与原始数据查看用） */
export function sliceEntry(buf: Buffer, entry: DatEntry): Buffer {
  const start = Math.max(0, Math.min(entry.offset, buf.length));
  const end = Math.max(start, Math.min(entry.offset + entry.size, buf.length));
  return Buffer.from(buf.subarray(start, end));
}

/** 读取用于魔数预览的一小段数据（PBG3/PBG4 需先解压才能看到真实魔数） */
function readPreview(buf: Buffer, offset: number, zsize: number): Buffer {
  const start = Math.max(0, Math.min(offset, buf.length));
  const len = Math.min(Math.max(zsize, 0), 64 * 1024);
  const chunk = buf.subarray(start, Math.min(start + len, buf.length));
  // 压缩数据里通常仍能找到内嵌的 PNG/JPEG 魔数片段，用于初步分类
  return chunk;
}

function safe<T>(fn: () => T | null): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
