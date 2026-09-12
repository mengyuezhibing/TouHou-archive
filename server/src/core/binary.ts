import { Buffer } from 'node:buffer';

/**
 * 小端二进制读取器。
 * 东方系列（ZUN Engine）的文件格式全部为小端序。
 */
export class BinaryReader {
  private readonly view: DataView;

  constructor(
    public readonly buf: Buffer,
    public pos = 0,
  ) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get size(): number {
    return this.buf.length;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  seek(p: number): this {
    this.pos = p;
    return this;
  }

  skip(n: number): this {
    this.pos += n;
    return this;
  }

  u8(): number {
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  i8(): number {
    const v = this.view.getInt8(this.pos);
    this.pos += 1;
    return v;
  }

  u16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  i16(): number {
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f64(): number {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  peekU32(offset = 0): number {
    if (offset + 4 > this.buf.length) return -1;
    return this.view.getUint32(offset, true);
  }

  /** 读取 n 字节，返回子 Buffer（复制，避免共享底层池） */
  bytes(n: number): Buffer {
    const end = Math.min(this.pos + n, this.buf.length);
    const out = Buffer.from(this.buf.subarray(this.pos, end));
    this.pos = end;
    return out;
  }

  /** 读取 NUL 结尾字符串（遇到 0 停止，最多 max 字节） */
  cstring(max = 256): string {
    const start = this.pos;
    let end = start;
    while (end < this.buf.length && this.buf[end] !== 0 && end - start < max) end++;
    const s = this.buf.toString('latin1', start, end);
    this.pos = Math.min(end + 1, this.buf.length);
    return s;
  }

  /** 读取定长字符串（去除 NUL 填充与首尾空白） */
  fixedString(len: number): string {
    const start = this.pos;
    const end = Math.min(start + len, this.buf.length);
    let stop = end;
    while (stop > start && this.buf[stop - 1] === 0) stop--;
    const s = this.buf.toString('latin1', start, stop);
    this.pos = start + len;
    return s;
  }
}

/** 在 buffer 中查找字节序列，返回所有命中偏移 */
export function findAll(buf: Buffer, needle: Buffer, limit = 100000): number[] {
  const out: number[] = [];
  let i = 0;
  while (i <= buf.length - needle.length) {
    const idx = buf.indexOf(needle, i);
    if (idx === -1) break;
    out.push(idx);
    i = idx + 1;
    if (out.length >= limit) break;
  }
  return out;
}

/** 对偏移序列排序并按最小间隔去重 */
export function dedupeOffsets(offsets: number[], minGap = 1): number[] {
  const sorted = [...offsets].sort((a, b) => a - b);
  const out: number[] = [];
  for (const o of sorted) {
    if (out.length === 0 || o - out[out.length - 1] >= minGap) out.push(o);
  }
  return out;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 判断字符串是否为"看起来合法"的文件名（DAT 表项校验用） */
export function looksLikeFilename(s: string): boolean {
  if (s.length === 0 || s.length > 64) return false;
  let printable = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c === 0) break;
    const ok =
      (c >= 0x20 && c <= 0x7e) || // ASCII 可打印
      (c >= 0xa1 && c <= 0xdf); // Shift-JIS 半角片假名
    if (!ok) return false;
    printable++;
  }
  return printable > 0;
}
