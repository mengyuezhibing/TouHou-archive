import { Buffer } from 'node:buffer';

/**
 * 东方系列归档使用的 LZSS 压缩。
 *
 * 严格对照 thtk/thlzss.c：
 *   - 环形字典 8192 字节（掩码 0x1fff），写指针从 1 开始（dict[0] 保留为终止标记）
 *   - 最小匹配 3 字节，最大 18 字节
 *   - 位流（MSB-first）：[1 位标志]
 *       flag = 1 → 后随 8 位字面量
 *       flag = 0 → 后随 13 位偏移 + 4 位 (长度 - 3)
 *   - 偏移为 0 即为终止标记（不再读取长度字段）
 *   - 匹配为「边读边写回字典」，因此支持自重叠的游程复制
 */

const DICT_SIZE = 0x2000;
const DICT_MASK = 0x1fff;
const MIN_MATCH = 3;
const MAX_MATCH = 18;

/** 从压缩数据的 startOffset 处解压，精确产出 outputSize 字节 */
export function lzssDecompress(input: Buffer, outputSize: number, startOffset = 0): Buffer {
  const out = Buffer.alloc(outputSize);
  const dict = Buffer.alloc(DICT_SIZE);
  let dictHead = 1;
  let written = 0;

  const br = new BitReaderLite(input, startOffset);

  while (written < outputSize) {
    if (br.read(1)) {
      const c = br.read(8);
      out[written++] = c;
      dict[dictHead] = c;
      dictHead = (dictHead + 1) & DICT_MASK;
    } else {
      const matchOffset = br.read(13);
      if (!matchOffset) {
        // 终止标记：真实长度可能小于预估输出长度（PBG4 的索引表就是这种情况）
        return Buffer.from(out.subarray(0, Math.min(written, outputSize)));
      }
      const matchLen = br.read(4) + MIN_MATCH;
      for (let i = 0; i < matchLen; i++) {
        const c = dict[(matchOffset + i) & DICT_MASK];
        // 字典必须先于边界判断更新，保证后续匹配偏移仍然正确
        if (written < outputSize) out[written] = c;
        written++;
        dict[dictHead] = c;
        dictHead = (dictHead + 1) & DICT_MASK;
      }
    }
  }
  return out;
}

/** LZSS 压缩（贪心最长匹配，用于演示数据集构造） */
export function lzssCompress(input: Buffer): Buffer {
  const out: number[] = [];
  const dict = Buffer.alloc(DICT_SIZE);
  let dictHead = 1;

  const pushBit = (bit: number) => {
    out.push(bit);
  };

  let i = 0;
  while (i < input.length) {
    // 在字典中寻找最长匹配
    let bestLen = 0;
    let bestOffset = 0;
    const maxLen = Math.min(MAX_MATCH, input.length - i);

    if (maxLen >= MIN_MATCH) {
      for (let offset = 1; offset < DICT_SIZE && offset <= i; offset++) {
        // 关键约束：匹配不得跨越字典写入位置。
        // 解压端是「边读边写」的，若允许重叠，它在读到尚未写入的槽位时会取到
        // 本次刚写回的字节，而压缩端看到的是初始 0，两端语义分歧会导致解压结果错误。
        const limit = Math.min(maxLen, i + 1 - offset);
        if (limit <= bestLen) continue;
        let len = 0;
        while (len < limit && dict[(offset + len) & DICT_MASK] === input[i + len]) len++;
        if (len > bestLen) {
          bestLen = len;
          bestOffset = offset;
          if (bestLen === maxLen) break;
        }
      }
    }

    if (bestLen >= MIN_MATCH) {
      pushBit(0);
      writeBits(out, 13, bestOffset);
      writeBits(out, 4, bestLen - MIN_MATCH);
      for (let k = 0; k < bestLen; k++) {
        const c = input[i + k];
        dict[dictHead] = c;
        dictHead = (dictHead + 1) & DICT_MASK;
      }
      i += bestLen;
    } else {
      const c = input[i];
      pushBit(1);
      writeBits(out, 8, c);
      dict[dictHead] = c;
      dictHead = (dictHead + 1) & DICT_MASK;
      i++;
    }
  }

  // 终止标记：flag=0 + 13 位偏移 0（长度位可省略，此处与 thtk 一致地写出 0）
  pushBit(0);
  writeBits(out, 13, 0);
  writeBits(out, 4, 0);

  return bitsToBuffer(out);
}

function writeBits(bits: number[], count: number, value: number): void {
  for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function bitsToBuffer(bits: number[]): Buffer {
  const bytes: number[] = [];
  let byte = 0;
  let n = 0;
  for (const b of bits) {
    byte = ((byte << 1) | b) & 0xff;
    n++;
    if (n === 8) {
      bytes.push(byte);
      byte = 0;
      n = 0;
    }
  }
  if (n > 0) {
    byte = (byte << (8 - n)) & 0xff;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** 轻量位读取器（避免与 BitReader 循环依赖） */
class BitReaderLite {
  private byte = 0;
  private bits = 0;
  private pos: number;

  constructor(
    private readonly buf: Buffer,
    start = 0,
  ) {
    this.pos = start;
  }

  read(n: number): number {
    if (n <= 0) return 0;
    while (this.bits < n) {
      const c = this.pos < this.buf.length ? this.buf[this.pos++] : 0;
      this.byte = ((this.byte << 8) | c) >>> 0;
      this.bits += 8;
    }
    this.bits -= n;
    return (this.byte >>> this.bits) & ((1 << n) - 1);
  }
}
