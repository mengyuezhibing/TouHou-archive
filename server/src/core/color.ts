import type { RawImage } from './png.ts';

/** 颜色分析：用于角色/素材的自动画像（对应设计文档第七节"颜色"字段） */

export interface ColorAnalysis {
  dominantHex: string;
  dominantName: string;
  names: string[];
  palette: { hex: string; ratio: number; name: string }[];
  opaqueRatio: number;
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function colorName(r: number, g: number, b: number, a: number): string {
  if (a < 32) return '透明';
  const { h, s, v } = rgbToHsv(r, g, b);
  if (v < 0.16) return '黑';
  if (s < 0.12) {
    if (v > 0.88) return '白';
    if (v > 0.6) return '浅灰';
    return '灰';
  }
  if (h < 12 || h >= 345) return v < 0.45 ? '暗红' : '红';
  if (h < 40) return v < 0.5 && s < 0.6 ? '棕' : '橙';
  if (h < 68) return '黄';
  if (h < 95) return '黄绿';
  if (h < 150) return '绿';
  if (h < 190) return '青';
  if (h < 250) return v < 0.4 ? '深蓝' : '蓝';
  if (h < 290) return '紫';
  if (h < 330) return '品红';
  return '粉';
}

/** 对 RGBA 图像做量化直方图 + 色名归并 */
export function analyzeColors(img: RawImage, sampleStep = 1): ColorAnalysis {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  let opaque = 0;
  let total = 0;

  const step = Math.max(1, sampleStep);
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const i = (y * img.width + x) * 4;
      const a = img.data[i + 3];
      total++;
      if (a < 32) continue;
      opaque++;
      const r = img.data[i];
      const g = img.data[i + 1];
      const b = img.data[i + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const cur = buckets.get(key);
      if (cur) {
        cur.count++;
        cur.r += r;
        cur.g += g;
        cur.b += b;
      } else {
        buckets.set(key, { count: 1, r, g, b });
      }
    }
  }

  if (opaque === 0) {
    return { dominantHex: '#00000000', dominantName: '透明', names: [], palette: [], opaqueRatio: 0 };
  }

  const sorted = [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, 8);
  const palette = sorted.map((c) => {
    const r = Math.round(c.r / c.count);
    const g = Math.round(c.g / c.count);
    const b = Math.round(c.b / c.count);
    return {
      hex: `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`,
      ratio: Number((c.count / opaque).toFixed(3)),
      name: colorName(r, g, b, 255),
    };
  });

  const names: string[] = [];
  for (const p of palette) {
    if (p.ratio >= 0.06 && !names.includes(p.name)) names.push(p.name);
    if (names.length >= 4) break;
  }

  return {
    dominantHex: palette[0]?.hex ?? '#000000',
    dominantName: palette[0]?.name ?? '未知',
    names,
    palette,
    opaqueRatio: Number((opaque / total).toFixed(3)),
  };
}
