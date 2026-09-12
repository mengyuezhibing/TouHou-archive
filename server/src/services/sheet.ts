import { Buffer } from 'node:buffer';
import { blitImage, createCanvas, encodePng, type RawImage } from '../core/png.ts';

/**
 * Sprite Sheet 生成（对应设计文档 5.2）。
 * 输出 TexturePacker JSON Hash 格式，可直接导入 Unity / Godot / Unreal。
 */

export interface SheetFrame {
  name: string;
  image: RawImage;
  spriteId: number;
}

export interface SheetOutput {
  png: Buffer;
  /** TexturePacker JSON Hash */
  json: Record<string, unknown>;
  width: number;
  height: number;
  frameCount: number;
  /** 未能放入的帧（超过尺寸上限） */
  overflow: number;
}

export interface SheetOptions {
  maxWidth?: number;
  maxHeight?: number;
  padding?: number;
  /** 名称生成器 */
  nameOf?: (f: SheetFrame, index: number) => string;
  appName?: string;
  source?: string;
  gameId?: string;
}

/**
 * 采用 shelf（货架）装箱：按高度降序排列后逐行摆放。
 * 相比朴素网格能显著减少浪费，且实现简单、结果稳定。
 */
export function packSheet(frames: SheetFrame[], options: SheetOptions = {}): SheetOutput | null {
  if (frames.length === 0) return null;

  const maxWidth = options.maxWidth ?? 2048;
  const maxHeight = options.maxHeight ?? 4096;
  const padding = options.padding ?? 2;
  const nameOf = options.nameOf ?? ((f, i) => `${f.name || `frame_${i}`}`);

  // 过滤空帧
  const usable = frames.filter((f) => f.image.width > 0 && f.image.height > 0 && f.image.width <= maxWidth && f.image.height <= maxHeight);
  const overflow = frames.length - usable.length;
  if (usable.length === 0) return null;

  const sorted = [...usable].sort((a, b) => b.image.height - a.image.height);

  interface Placed {
    frame: SheetFrame;
    x: number;
    y: number;
    index: number;
  }
  const placed: Placed[] = [];
  let cursorX = padding;
  let cursorY = padding;
  let shelfHeight = 0;
  let usedWidth = 0;

  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i];
    const w = f.image.width;
    const h = f.image.height;

    if (cursorX + w + padding > maxWidth) {
      cursorX = padding;
      cursorY += shelfHeight + padding;
      shelfHeight = 0;
    }
    if (cursorY + h + padding > maxHeight) {
      // 超出画布：终止装箱，剩余帧计入 overflow
      return finalize(placed, sorted.length - placed.length, cursorY + shelfHeight + padding, usedWidth, padding, maxHeight, options, nameOf);
    }
    placed.push({ frame: f, x: cursorX, y: cursorY, index: i });
    cursorX += w + padding;
    shelfHeight = Math.max(shelfHeight, h);
    usedWidth = Math.max(usedWidth, cursorX);
  }

  return finalize(placed, overflow, cursorY + shelfHeight + padding, usedWidth, padding, maxHeight, options, nameOf);
}

function finalize(
  placed: Array<{ frame: SheetFrame; x: number; y: number; index: number }>,
  overflow: number,
  contentHeight: number,
  contentWidth: number,
  padding: number,
  maxHeight: number,
  options: SheetOptions,
  nameOf: (f: SheetFrame, index: number) => string,
): SheetOutput {
  const width = Math.min(options.maxWidth ?? 2048, Math.max(1, contentWidth + padding));
  const height = Math.min(maxHeight, Math.max(1, contentHeight + padding));

  const canvas = createCanvas(width, height);
  for (const p of placed) {
    blitImage(canvas, p.frame.image, p.x, p.y);
  }

  const frameMap: Record<string, unknown> = {};
  placed.forEach((p, idx) => {
    const name = nameOf(p.frame, idx);
    frameMap[name] = {
      frame: { x: p.x, y: p.y, w: p.frame.image.width, h: p.frame.image.height },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: p.frame.image.width, h: p.frame.image.height },
      sourceSize: { w: p.frame.image.width, h: p.frame.image.height },
      pivot: { x: 0.5, y: 0.5 },
      spriteId: p.frame.spriteId,
    };
  });

  const json = {
    frames: frameMap,
    meta: {
      app: options.appName ?? 'Touhou Resource Studio',
      version: '1.0',
      image: 'sheet.png',
      format: 'RGBA8888',
      size: { w: width, h: height },
      scale: '1',
      game: options.gameId ?? '',
      source: options.source ?? '',
      frameCount: placed.length,
      overflow,
    },
  };

  return {
    png: encodePng(canvas),
    json,
    width,
    height,
    frameCount: placed.length,
    overflow,
  };
}
