/**
 * 极简 MessagePack 解码器。
 *
 * TH06NC 用 msgpack 存本地化表（localization.msgpack / spellpractice.msgpack），
 * 这里只实现该文件实际用到的子集：nil/bool/int/float/str/bin/map/array 的
 * fix* 与 16/32 位变体。遇到未知头直接抛错，避免静默产出坏数据。
 *
 * 注意多字节长度类型（str16/32、bin16、array16/32、map16/32）的长度字段
 * 本身也要消费掉——漏掉会造成 2~4 字节的静默漂移，且下游常常「看起来能解」，
 * 极难排查（首个版本就栽在这里）。
 */
export function decodeMsgpack(buf: Buffer): unknown {
  const pos = { i: 0 };
  const value = decodeValue(buf, pos);
  if (pos.i > buf.length) {
    throw new Error(`msgpack 越界: ${pos.i} > ${buf.length}`);
  }
  return value;
}

function decodeValue(b: Buffer, pos: { i: number }): unknown {
  if (pos.i >= b.length) {
    throw new Error(`msgpack 提前结束 @${pos.i}/${b.length}`);
  }
  const c = b[pos.i++];
  // 正 fixint / 负 fixint
  if (c <= 0x7f) return c;
  if (c >= 0xe0) return c - 256;
  // fixmap / fixarray / fixstr
  if (c >= 0x80 && c <= 0x8f) return decodeMap(b, pos, c & 0x0f);
  if (c >= 0x90 && c <= 0x9f) return decodeArray(b, pos, c & 0x0f);
  if (c >= 0xa0 && c <= 0xbf) return readStr(b, pos, c - 0xa0);
  switch (c) {
    case 0xc0: return null;
    case 0xc2: return false;
    case 0xc3: return true;
    case 0xc4: return readBin(b, pos, u8(b, pos));
    case 0xc5: return readBin(b, pos, u16(b, pos));
    case 0xc6: return readBin(b, pos, u32(b, pos));
    case 0xca: { const v = b.readFloatBE(pos.i); pos.i += 4; return v; }
    case 0xcb: { const v = b.readDoubleBE(pos.i); pos.i += 8; return v; }
    case 0xcc: return u8(b, pos);
    case 0xcd: return u16(b, pos);
    case 0xce: return u32(b, pos);
    case 0xcf: { const v = b.readBigUInt64BE(pos.i); pos.i += 8; return v; }
    case 0xd0: { const v = b.readInt8(pos.i); pos.i += 1; return v; }
    case 0xd1: { const v = b.readInt16BE(pos.i); pos.i += 2; return v; }
    case 0xd2: { const v = b.readInt32BE(pos.i); pos.i += 4; return v; }
    case 0xd9: return readStr(b, pos, u8(b, pos));
    case 0xda: return readStr(b, pos, u16(b, pos));
    case 0xdb: return readStr(b, pos, u32(b, pos));
    case 0xdc: return decodeArray(b, pos, u16(b, pos));
    case 0xdd: return decodeArray(b, pos, u32(b, pos));
    case 0xde: return decodeMap(b, pos, u16(b, pos));
    case 0xdf: return decodeMap(b, pos, u32(b, pos));
    default:
      throw new Error(`不支持的 msgpack 头 0x${c.toString(16)} @${pos.i - 1}`);
  }
}

function u8(b: Buffer, pos: { i: number }): number {
  return b[pos.i++];
}
function u16(b: Buffer, pos: { i: number }): number {
  const v = b.readUInt16BE(pos.i);
  pos.i += 2;
  return v;
}
function u32(b: Buffer, pos: { i: number }): number {
  const v = b.readUInt32BE(pos.i);
  pos.i += 4;
  return v;
}

function readStr(b: Buffer, pos: { i: number }, len: number): string {
  if (!Number.isFinite(len) || len < 0 || pos.i + len > b.length) {
    throw new Error(`msgpack 字符串长度异常: len=${len} @${pos.i}/${b.length}`);
  }
  const s = b.toString('utf8', pos.i, pos.i + len);
  pos.i += len;
  return s;
}

function readBin(b: Buffer, pos: { i: number }, len: number): Buffer {
  if (!Number.isFinite(len) || len < 0 || pos.i + len > b.length) {
    throw new Error(`msgpack bin 长度异常: len=${len} @${pos.i}/${b.length}`);
  }
  const s = b.subarray(pos.i, pos.i + len);
  pos.i += len;
  return Buffer.from(s);
}

function decodeArray(b: Buffer, pos: { i: number }, len: number): unknown[] {
  const out: unknown[] = [];
  for (let k = 0; k < len; k++) out.push(decodeValue(b, pos));
  return out;
}

function decodeMap(b: Buffer, pos: { i: number }, len: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let k = 0; k < len; k++) {
    const key = decodeValue(b, pos);
    out[String(key)] = decodeValue(b, pos);
  }
  return out;
}
