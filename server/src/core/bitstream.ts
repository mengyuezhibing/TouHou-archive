import { Buffer } from 'node:buffer';

/**
 * MSB-first 位流读写器。
 *
 * 对照 thtk/bits.c：读写均为大端位序（先进入流的位 = 数值最高位）。
 * TH06(PBG3) 的归档条目表就是位流编码的变长整数序列，因此必须先有这一层。
 */
export class BitReader {
  private byte = 0;
  private bits = 0;
  /** 底层字节游标 */
  private pos: number;

  constructor(
    private readonly buf: Buffer,
    start = 0,
  ) {
    this.pos = start;
  }

  /** 当前已消费的字节数（位流读取是不对齐的，该值仅用于定位） */
  get byteCount(): number {
    return this.pos;
  }

  /** 跳转到字节边界处的指定偏移，并清空位缓冲 */
  seekByte(p: number): void {
    this.pos = Math.max(0, Math.min(p, this.buf.length));
    this.byte = 0;
    this.bits = 0;
  }

  /** 读取 n 位（n <= 32） */
  read(n: number): number {
    if (n <= 0) return 0;
    if (n > 25) {
      // 分块规避 32 位移位溢出（与 thtk 一致）
      const hi = this.read(24);
      const rest = n - 24;
      return ((hi << rest) | this.read(rest)) >>> 0;
    }
    while (this.bits < n) {
      const c = this.pos < this.buf.length ? this.buf[this.pos++] : 0;
      // 每步保留低 32 位：高位是已消费的残留，左移溢出时自然丢弃
      this.byte = ((this.byte << 8) | c) >>> 0;
      this.bits += 8;
    }
    this.bits -= n;
    return (this.byte >>> this.bits) & ((1 << n) - 1);
  }

  readBit(): number {
    return this.read(1);
  }

  /** 读变长整数：2 位长度码 + (code+1) 字节（PBG3 条目表使用） */
  readVariableUInt(): number {
    const sizeCode = this.read(2);
    return this.read((sizeCode + 1) * 8);
  }

  /** 读 NUL 结尾字符串 */
  readCString(max = 256): string {
    const bytes: number[] = [];
    for (let i = 0; i < max; i++) {
      const c = this.read(8);
      if (c === 0) break;
      bytes.push(c);
    }
    return Buffer.from(bytes).toString('latin1');
  }
}

/** MSB-first 位流写入器（用于演示数据集构造与格式回写） */
export class BitWriter {
  private byte = 0;
  private bits = 0;
  private readonly chunks: number[] = [];

  /** 写入 n 位（取 value 的低 n 位，高位先写） */
  write(n: number, value: number): void {
    const bits = Math.min(n, 32);
    for (let i = bits - 1; i >= 0; i--) {
      this.writeBit((value >>> i) & 1);
      if (bits > 32) break;
    }
    if (n > 32) {
      // 超出 32 位的部分补 0
      for (let i = 0; i < n - 32; i++) this.writeBit(0);
    }
  }

  writeBit(bit: number): void {
    this.byte = ((this.byte << 1) | (bit & 1)) & 0xff;
    this.bits++;
    if (this.bits === 8) {
      this.chunks.push(this.byte);
      this.byte = 0;
      this.bits = 0;
    }
  }

  /** 以最小编码宽度写入变长整数（PBG3 条目表使用） */
  writeVariableUInt(value: number): void {
    let sizeCode: number;
    if (value < 0x100) sizeCode = 0;
    else if (value < 0x10000) sizeCode = 1;
    else if (value < 0x1000000) sizeCode = 2;
    else sizeCode = 3;
    this.write(2, sizeCode);
    this.write((sizeCode + 1) * 8, value);
  }

  writeCString(s: string): void {
    for (const b of Buffer.from(s, 'latin1')) this.write(8, b);
    this.write(8, 0);
  }

  /** 补 0 至字节边界并返回结果 */
  finish(): Buffer {
    while (this.bits) this.writeBit(0);
    return Buffer.from(this.chunks);
  }

  /** 当前已产出的完整字节数（不含未满的尾字节） */
  get byteCount(): number {
    return this.chunks.length;
  }
}
