import { Buffer } from 'node:buffer';

/**
 * 东方系列归档数据的加解密（th_crypt）。
 *
 * 严格对照 thtk/thcrypt.c：按 block 分块，块内做「倒序 + 奇偶去交错」置换，
 * 每个目的字节 j 的密钥为 key + j*step（模 256），块间按 N*step（偶数块）
 * 或 (N+1)*step（奇数块）递推。size 会先被预处理丢弃过短的尾部。
 */

export interface CryptParams {
  key: number;
  step: number;
  block: number;
  limit: number;
}

export interface TypedCryptParams extends CryptParams {
  /** 类型标识字符：'M'|'T'|'A'|'J'|'E'|'W'|'-'|'*' */
  type: string;
}

/** TH08 加密参数表（type 字段直接来自数据头） */
export const TH08_CRYPT_PARAMS: TypedCryptParams[] = [
  { type: 'M', key: 0x1b, step: 0x37, block: 0x40, limit: 0x2000 },
  { type: 'T', key: 0x51, step: 0xe9, block: 0x40, limit: 0x3000 },
  { type: 'A', key: 0xc1, step: 0x51, block: 0x1400, limit: 0x2000 },
  { type: 'J', key: 0x03, step: 0x19, block: 0x1400, limit: 0x7800 },
  { type: 'E', key: 0xab, step: 0xcd, block: 0x200, limit: 0x1000 },
  { type: 'W', key: 0x12, step: 0x34, block: 0x400, limit: 0x2800 },
  { type: '-', key: 0x35, step: 0x97, block: 0x80, limit: 0x2800 },
  { type: '*', key: 0x99, step: 0x37, block: 0x400, limit: 0x1000 },
];

/** TH09 加密参数表 */
export const TH09_CRYPT_PARAMS: TypedCryptParams[] = [
  { type: 'M', key: 0x1b, step: 0x37, block: 0x40, limit: 0x2800 },
  { type: 'T', key: 0x51, step: 0xe9, block: 0x40, limit: 0x3000 },
  { type: 'A', key: 0xc1, step: 0x51, block: 0x400, limit: 0x400 },
  { type: 'J', key: 0x03, step: 0x19, block: 0x400, limit: 0x400 },
  { type: 'E', key: 0xab, step: 0xcd, block: 0x200, limit: 0x1000 },
  { type: 'W', key: 0x12, step: 0x34, block: 0x400, limit: 0x400 },
  { type: '-', key: 0x35, step: 0x97, block: 0x80, limit: 0x2800 },
  { type: '*', key: 0x99, step: 0x37, block: 0x400, limit: 0x1000 },
];

/** 数组下标顺序固定为 M T A J E W - *，与 th08 的类型顺序一致 */
export const TH95_CRYPT_PARAMS: CryptParams[] = [
  { key: 0x1b, step: 0x37, block: 0x40, limit: 0x2800 },
  { key: 0x51, step: 0xe9, block: 0x40, limit: 0x3000 },
  { key: 0xc1, step: 0x51, block: 0x80, limit: 0x3200 },
  { key: 0x03, step: 0x19, block: 0x400, limit: 0x7800 },
  { key: 0xab, step: 0xcd, block: 0x200, limit: 0x2800 },
  { key: 0x12, step: 0x34, block: 0x80, limit: 0x3200 },
  { key: 0x35, step: 0x97, block: 0x80, limit: 0x2800 },
  { key: 0x99, step: 0x37, block: 0x400, limit: 0x2000 },
];

export const TH12_CRYPT_PARAMS: CryptParams[] = [
  { key: 0x1b, step: 0x73, block: 0x40, limit: 0x3800 },
  { key: 0x51, step: 0x9e, block: 0x40, limit: 0x4000 },
  { key: 0xc1, step: 0x15, block: 0x400, limit: 0x2c00 },
  { key: 0x03, step: 0x91, block: 0x80, limit: 0x6400 },
  { key: 0xab, step: 0xdc, block: 0x80, limit: 0x6e00 },
  { key: 0x12, step: 0x43, block: 0x200, limit: 0x3c00 },
  { key: 0x35, step: 0x79, block: 0x400, limit: 0x3c00 },
  { key: 0x99, step: 0x7d, block: 0x80, limit: 0x2800 },
];

export const TH13_CRYPT_PARAMS: CryptParams[] = [
  { key: 0x1b, step: 0x73, block: 0x100, limit: 0x3800 },
  { key: 0x12, step: 0x43, block: 0x200, limit: 0x3e00 },
  { key: 0x35, step: 0x79, block: 0x400, limit: 0x3c00 },
  { key: 0x03, step: 0x91, block: 0x80, limit: 0x6400 },
  { key: 0xab, step: 0xdc, block: 0x80, limit: 0x6e00 },
  { key: 0x51, step: 0x9e, block: 0x100, limit: 0x4000 },
  { key: 0xc1, step: 0x15, block: 0x400, limit: 0x2c00 },
  { key: 0x99, step: 0x7d, block: 0x80, limit: 0x4400 },
];

/** TH13 与 TH14 仅 ecl 对应的 limit 不同 */
export const TH14_CRYPT_PARAMS: CryptParams[] = TH13_CRYPT_PARAMS.map((p, i) => (i === 4 ? { ...p, limit: 0x7000 } : { ...p }));

/**
 * 各作品使用的加密参数表。
 * 未列出的作品（如 TH06/TH07）其归档数据不做加密。
 */
export const CRYPT_TABLE_BY_GAME: Record<string, CryptParams[] | TypedCryptParams[]> = {
  TH08: TH08_CRYPT_PARAMS,
  TH09: TH09_CRYPT_PARAMS,
  TH095: TH95_CRYPT_PARAMS,
  TH12: TH12_CRYPT_PARAMS,
  TH13: TH13_CRYPT_PARAMS,
  TH14: TH14_CRYPT_PARAMS,
};

/** 由条目名推断类型下标（M T A J E W - *） */
export function typeIndexFromName(name: string): number {
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.split('.').pop()! : '';
  if (ext === 'msg' || /^msg\d*$/.test(lower)) return 0;
  if (ext === 'txt') return 1;
  if (ext === 'anm' || /^anm$/.test(lower)) return 2;
  if (ext === 'jpg' || ext === 'jpeg' || ext === 'png' || ext === 'bmp') return 3;
  if (ext === 'ecl' || /^ecldata/.test(lower)) return 4;
  if (ext === 'wav' || ext === 'ogg') return 5;
  return 6;
}

/** 由类型字符取得 th08/th09 表项 */
export function paramsByTypeChar(table: TypedCryptParams[], typeChar: string): TypedCryptParams | null {
  return table.find((p) => p.type === typeChar) ?? table.find((p) => p.type === '-') ?? null;
}

const mod256 = (v: number) => ((v % 256) + 256) % 256;

/**
 * 计算目标下标 j 对应的源下标。
 * block 分块被拆成“前半（步长 2 递减）”与“后半（步长 2 递减，偏移 1）”两段。
 */
function sourceIndex(j: number, block: number, increment: number): number {
  return j < increment ? block - 1 - 2 * j : block - 2 - 2 * (j - increment);
}

/** 预处理后的有效解密长度 */
function effectiveSize(size: number, block: number): number {
  const quarter = block >> 2;
  if (size < quarter) return 0;
  const r = size % block;
  return size - (r < quarter ? r : 0) - (size & 1);
}

function alignUp(value: number, block: number): number {
  const r = value % block;
  return r === 0 ? value : value + (block - r);
}

/** 原地解密（返回同一 Buffer 以便链式调用） */
export function thDecrypt(data: Buffer, p: CryptParams): Buffer {
  const block0 = p.block;
  if (!block0) return data;

  const size = effectiveSize(data.length, block0);
  const limit = alignUp(p.limit, block0);
  const end = Math.min(size, limit);

  const temp = Buffer.alloc(block0);
  let key = p.key & 0xff;
  let off = 0;

  while (off < end) {
    let block = block0;
    if (end - off < block) block = end - off;
    const increment = (block >> 1) + (block & 1);

    for (let j = 0; j < block; j++) {
      const src = sourceIndex(j, block, increment);
      if (src >= block) continue;
      temp[src] = data[off + j] ^ mod256(key + j * p.step);
    }
    temp.copy(data, off, 0, block);

    key = mod256(key + (block & 1 ? block + 1 : block) * p.step);
    off += block;
  }
  return data;
}

/** 原地加密（thDecrypt 的逆运算，用于构造演示数据与格式回写） */
export function thEncrypt(data: Buffer, p: CryptParams): Buffer {
  const block0 = p.block;
  if (!block0) return data;

  const size = effectiveSize(data.length, block0);
  const limit = alignUp(p.limit, block0);
  const end = Math.min(size, limit);

  const temp = Buffer.alloc(block0);
  let key = p.key & 0xff;
  let off = 0;

  while (off < end) {
    let block = block0;
    if (end - off < block) block = end - off;
    const increment = (block >> 1) + (block & 1);

    for (let j = 0; j < block; j++) {
      const src = sourceIndex(j, block, increment);
      if (src >= block) continue;
      temp[j] = data[off + src] ^ mod256(key + j * p.step);
    }
    temp.copy(data, off, 0, block);

    key = mod256(key + (block & 1 ? block + 1 : block) * p.step);
    off += block;
  }
  return data;
}
