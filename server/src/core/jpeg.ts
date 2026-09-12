import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import type { RawImage } from './png.ts';

/**
 * JPEG 解码（用于红魔乡 / 妖妖梦的 ANM 内嵌贴图）。
 *
 * 这两作的 ANM 使用 JPEG 而非 PNG 存储贴图，且没有 alpha 通道——
 * ZUN 以纯黑填充透明区域。因此解码后需要一步「黑底转透明」的启发式还原，
 * 才能得到可用于图集合成的 RGBA 图像。
 */

const require = createRequire(import.meta.url);

interface JpegJs {
  decode(input: Uint8Array, options?: Record<string, unknown>): { width: number; height: number; data: Uint8Array };
}

let jpegLib: JpegJs | null = null;
try {
  jpegLib = require('jpeg-js') as JpegJs;
} catch {
  jpegLib = null;
}

export function isJpeg(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

export function isJpegAvailable(): boolean {
  return jpegLib !== null;
}

export function decodeJpeg(buf: Buffer): RawImage | null {
  if (!jpegLib) return null;
  try {
    const out = jpegLib.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512, tolerantDecoding: true });
    if (!out?.width || !out?.height || !out.data) return null;
    if (out.width > 8192 || out.height > 8192) return null;
    return {
      width: out.width,
      height: out.height,
      data: Buffer.from(out.data.buffer, out.data.byteOffset, out.data.length),
    };
  } catch {
    return null;
  }
}

/**
 * 黑底转透明。
 * 仅当图像四角中有 3 个以上为近黑像素时才执行，避免误伤本身以黑色为主的贴图。
 * 返回是否执行了转换。
 */
export function applyBlackAsAlpha(img: RawImage, threshold = 24): boolean {
  const { width, height, data } = img;
  if (width < 2 || height < 2) return false;

  const corners: Array<[number, number]> = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];

  let dark = 0;
  for (const [x, y] of corners) {
    const i = (y * width + x) * 4;
    if (data[i] <= threshold && data[i + 1] <= threshold && data[i + 2] <= threshold) dark++;
  }
  if (dark < 3) return false;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i] <= threshold && data[i + 1] <= threshold && data[i + 2] <= threshold) {
      data[i + 3] = 0;
    }
  }
  return true;
}
