import { Buffer } from 'node:buffer';
import zlib from 'node:zlib';

/**
 * 零依赖 PNG 编解码器。
 * 用于 ANM 内嵌贴图的解码与 Sprite Sheet 的合成。
 * 支持 colorType 0/2/3/4/6，bitDepth 8/16，非隔行。
 */

export interface RawImage {
  width: number;
  height: number;
  /** RGBA8，长度 = width * height * 4 */
  data: Buffer;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG);
}

// ---------------------------------------------------------------- 解码

export function decodePng(buf: Buffer): RawImage | null {
  try {
    if (!isPng(buf)) return null;
    let pos = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 8;
    let colorType = 6;
    let interlace = 0;
    let palette: Buffer | null = null;
    let trns: Buffer | null = null;
    const idat: Buffer[] = [];

    while (pos + 8 <= buf.length) {
      const len = buf.readUInt32BE(pos);
      const type = buf.toString('latin1', pos + 4, pos + 8);
      const dataStart = pos + 8;
      const dataEnd = dataStart + len;
      if (dataEnd > buf.length) break;

      if (type === 'IHDR') {
        width = buf.readUInt32BE(dataStart);
        height = buf.readUInt32BE(dataStart + 4);
        bitDepth = buf[dataStart + 8];
        colorType = buf[dataStart + 9];
        interlace = buf[dataStart + 12];
      } else if (type === 'PLTE') {
        palette = Buffer.from(buf.subarray(dataStart, dataEnd));
      } else if (type === 'tRNS') {
        trns = Buffer.from(buf.subarray(dataStart, dataEnd));
      } else if (type === 'IDAT') {
        idat.push(Buffer.from(buf.subarray(dataStart, dataEnd)));
      } else if (type === 'IEND') {
        break;
      }
      pos = dataEnd + 4; // 跳过 CRC
    }

    if (!width || !height || idat.length === 0) return null;
    if (width > 8192 || height > 8192) return null;

    const raw = zlib.inflateSync(Buffer.concat(idat));
    const channels = channelCount(colorType);
    if (channels === 0) return null;

    const bytesPerPixel = Math.max(1, (channels * bitDepth) / 8);
    const bitsPerPixel = channels * bitDepth;
    const bytesPerRow = Math.ceil((width * bitsPerPixel) / 8);

    const expected = bytesPerRow * height;
    if (raw.length < expected) return null;

    // 反 filter（逐行）
    const unfiltered = unfilterRows(raw, width, height, bytesPerRow, bytesPerPixel);

    // 转 RGBA8
    const out = Buffer.alloc(width * height * 4);
    convertToRgba(unfiltered, out, width, height, bitDepth, colorType, palette, trns, bytesPerRow);
    return { width, height, data: out };
  } catch {
    return null;
  }
}

function channelCount(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1; // 灰度
    case 2:
      return 3; // RGB
    case 3:
      return 1; // 索引
    case 4:
      return 2; // 灰度 + Alpha
    case 6:
      return 4; // RGBA
    default:
      return 0;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilterRows(raw: Buffer, width: number, height: number, bytesPerRow: number, bpp: number): Buffer {
  const out = Buffer.alloc(bytesPerRow * height);
  let prevRowStart = -1;

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (bytesPerRow + 1)];
    const srcStart = y * (bytesPerRow + 1) + 1;
    const dstStart = y * bytesPerRow;

    for (let x = 0; x < bytesPerRow; x++) {
      const rawByte = raw[srcStart + x] ?? 0;
      const left = x >= bpp ? out[dstStart + x - bpp] : 0;
      const up = prevRowStart >= 0 ? out[prevRowStart + x] : 0;
      const upLeft = prevRowStart >= 0 && x >= bpp ? out[prevRowStart + x - bpp] : 0;

      let val: number;
      switch (filter) {
        case 0:
          val = rawByte;
          break;
        case 1:
          val = rawByte + left;
          break;
        case 2:
          val = rawByte + up;
          break;
        case 3:
          val = rawByte + ((left + up) >> 1);
          break;
        case 4:
          val = rawByte + paeth(left, up, upLeft);
          break;
        default:
          val = rawByte;
      }
      out[dstStart + x] = val & 0xff;
    }
    prevRowStart = dstStart;
  }
  return out;
}

function convertToRgba(
  src: Buffer,
  dst: Buffer,
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  palette: Buffer | null,
  trns: Buffer | null,
  bytesPerRow: number,
): void {
  const maxIn = (1 << bitDepth) - 1;
  const scale = (v: number) => Math.round((v / maxIn) * 255);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const di = (y * width + x) * 4;
      const rowStart = y * bytesPerRow;

      if (colorType === 0) {
        let g: number;
        if (bitDepth === 8) g = src[rowStart + x];
        else if (bitDepth === 16) g = src[rowStart + x * 2];
        else {
          const perByte = 8 / bitDepth;
          const byte = src[rowStart + Math.floor(x / perByte)];
          const shift = 8 - bitDepth * ((x % perByte) + 1);
          g = (byte >> shift) & maxIn;
        }
        const v = scale(g);
        dst[di] = v;
        dst[di + 1] = v;
        dst[di + 2] = v;
        dst[di + 3] = 255;
      } else if (colorType === 2) {
        const step = bitDepth === 16 ? 2 : 1;
        const base = rowStart + x * 3 * step;
        dst[di] = bitDepth === 16 ? src[base] : src[base];
        dst[di + 1] = src[base + step];
        dst[di + 2] = src[base + step * 2];
        dst[di + 3] = 255;
      } else if (colorType === 3) {
        const idx = src[rowStart + x];
        const p = palette ?? Buffer.alloc(0);
        dst[di] = p[idx * 3] ?? 0;
        dst[di + 1] = p[idx * 3 + 1] ?? 0;
        dst[di + 2] = p[idx * 3 + 2] ?? 0;
        dst[di + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (colorType === 4) {
        const step = bitDepth === 16 ? 2 : 1;
        const base = rowStart + x * 2 * step;
        const v = src[base];
        dst[di] = v;
        dst[di + 1] = v;
        dst[di + 2] = v;
        dst[di + 3] = src[base + step];
      } else {
        const step = bitDepth === 16 ? 2 : 1;
        const base = rowStart + x * 4 * step;
        dst[di] = src[base];
        dst[di + 1] = src[base + step];
        dst[di + 2] = src[base + step * 2];
        dst[di + 3] = src[base + step * 3];
      }
    }
  }
}

// ---------------------------------------------------------------- 编码

function crc32(buf: Buffer): number {
  let c: number;
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    crc = (crc >>> 8) ^ table[c];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

let crcTable: Uint32Array | null = null;
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  crcTable = t;
  return t;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 将 RGBA8 图像编码为 PNG */
export function encodePng(img: RawImage): Buffer {
  const { width, height, data } = img;
  const bytesPerRow = width * 4;
  const raw = Buffer.alloc((bytesPerRow + 1) * height);

  for (let y = 0; y < height; y++) {
    raw[y * (bytesPerRow + 1)] = 0; // filter: none
    data.copy(raw, y * (bytesPerRow + 1) + 1, y * bytesPerRow, (y + 1) * bytesPerRow);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idatData = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', idatData), chunk('IEND', Buffer.alloc(0))]);
}

/** 创建空白 RGBA 画布 */
export function createCanvas(width: number, height: number, fill: [number, number, number, number] = [0, 0, 0, 0]): RawImage {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = fill[3];
  }
  return { width, height, data };
}

/**
 * 从图像中裁出一块矩形区域。
 *
 * ANM 的 region 表用浮点描述精灵在贴图中的位置与尺寸，因此:
 *   · 坐标与尺寸都做四舍五入，避免亚像素导致 1px 抖动
 *   · 越界部分留空（透明），不抛错 —— 个别版本的 region 会略微超出画布
 */
export function cropImage(src: RawImage, x: number, y: number, w: number, h: number): RawImage {
  const out = createCanvas(w, h);
  for (let j = 0; j < h; j++) {
    const sy = y + j;
    if (sy < 0 || sy >= src.height) continue;
    for (let i = 0; i < w; i++) {
      const sx = x + i;
      if (sx < 0 || sx >= src.width) continue;
      const si = (sy * src.width + sx) * 4;
      const di = (j * w + i) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

/** 把 src 贴到 dst 的 (dx, dy) 处（alpha 混合，out-of-bounds 安全） */
export function blitImage(dst: RawImage, src: RawImage, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const si = (y * src.width + x) * 4;
      const di = (ty * dst.width + tx) * 4;
      const sa = src.data[si + 3] / 255;
      if (sa <= 0) continue;
      if (sa >= 1) {
        src.data.copy(dst.data, di, si, si + 4);
        continue;
      }
      dst.data[di] = Math.round(src.data[si] * sa + dst.data[di] * (1 - sa));
      dst.data[di + 1] = Math.round(src.data[si + 1] * sa + dst.data[di + 1] * (1 - sa));
      dst.data[di + 2] = Math.round(src.data[si + 2] * sa + dst.data[di + 2] * (1 - sa));
      dst.data[di + 3] = Math.min(255, Math.round(src.data[si + 3] + dst.data[di + 3] * (1 - sa)));
    }
  }
}
