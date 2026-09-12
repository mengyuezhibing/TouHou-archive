import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { createCanvas, encodePng, type RawImage } from '../core/png.ts';
import { BitWriter } from '../core/bitstream.ts';
import { lzssCompress, lzssDecompress } from '../core/lzss.ts';
import { FIXTURE_DIR, ensureDir } from '../core/paths.ts';
import { scanDirectory } from '../services/scanner.ts';
import { upsertGame } from '../services/query.ts';
import { extractGame } from '../services/extractor.ts';

/**
 * 演示数据集生成器。
 *
 * 按 **红魔乡（TH06）真实文件格式**合成一套最小可用的游戏文件：
 *   th06.exe / th06.dat（含 ANM、ECL、MSG、STD）/ thbgm.dat
 * 生成后自动完成"扫描 → 入库 → 解包"全流程，便于在无游戏本体时验证工作台能力。
 *
 * 生成的文件均标注为演示数据，避免与真实游戏文件混淆。
 */

type RGBA = [number, number, number, number];

const require = createRequire(import.meta.url);

/**
 * 把 RGBA 图像编码为 JPEG，并把透明像素填成纯黑。
 * 这正是红魔乡 / 妖妖梦 ANM 贴图的存储方式（JPEG 无 alpha，透明区以黑色表示），
 * 因此演示数据使用该编码可以覆盖「JPEG 解码 + 黑底转透明」这条真实代码路径。
 */
function encodeJpegFromRGBA(img: RawImage, quality = 85): Buffer {
  const rgb = Buffer.alloc(img.width * img.height * 4);
  for (let i = 0; i < img.width * img.height; i++) {
    const a = img.data[i * 4 + 3];
    const j = i * 4;
    if (a < 128) {
      rgb[j] = 0;
      rgb[j + 1] = 0;
      rgb[j + 2] = 0;
    } else {
      rgb[j] = img.data[j];
      rgb[j + 1] = img.data[j + 1];
      rgb[j + 2] = img.data[j + 2];
    }
    rgb[j + 3] = 255;
  }
  const jpeg = require('jpeg-js') as { encode(input: { data: Buffer; width: number; height: number }, quality: number): { data: Buffer } };
  return Buffer.from(jpeg.encode({ data: rgb, width: img.width, height: img.height }, quality).data);
}

// ---------------------------------------------------------------- 绘图工具

function fillRect(img: RawImage, x: number, y: number, w: number, h: number, color: readonly number[]): void {
  for (let py = Math.max(0, y); py < Math.min(img.height, y + h); py++) {
    for (let px = Math.max(0, x); px < Math.min(img.width, x + w); px++) {
      const i = (py * img.width + px) * 4;
      img.data[i] = color[0];
      img.data[i + 1] = color[1];
      img.data[i + 2] = color[2];
      img.data[i + 3] = color[3];
    }
  }
}

function fillCircle(img: RawImage, cx: number, cy: number, r: number, color: readonly number[]): void {
  for (let py = Math.max(0, cy - r); py <= Math.min(img.height - 1, cy + r); py++) {
    for (let px = Math.max(0, cx - r); px <= Math.min(img.width - 1, cx + r); px++) {
      const dx = px - cx;
      const dy = py - cy;
      if (dx * dx + dy * dy <= r * r) {
        const i = (py * img.width + px) * 4;
        img.data[i] = color[0];
        img.data[i + 1] = color[1];
        img.data[i + 2] = color[2];
        img.data[i + 3] = color[3];
      }
    }
  }
}

function fillRing(img: RawImage, cx: number, cy: number, r: number, thickness: number, color: readonly number[]): void {
  const inner = (r - thickness) * (r - thickness);
  const outer = r * r;
  for (let py = Math.max(0, cy - r); py <= Math.min(img.height - 1, cy + r); py++) {
    for (let px = Math.max(0, cx - r); px <= Math.min(img.width - 1, cx + r); px++) {
      const dx = px - cx;
      const dy = py - cy;
      const d = dx * dx + dy * dy;
      if (d <= outer && d >= inner) {
        const i = (py * img.width + px) * 4;
        img.data[i] = color[0];
        img.data[i + 1] = color[1];
        img.data[i + 2] = color[2];
        img.data[i + 3] = color[3];
      }
    }
  }
}

/** 简易人形自机立绘：发色 / 衣服色 / 蝴蝶结色 */
function drawCharacter(
  width: number,
  height: number,
  skin: readonly number[],
  hair: readonly number[],
  dress: readonly number[],
  ribbon: readonly number[],
  frame: number,
): RawImage {
  const img = createCanvas(width, height);
  const cx = Math.floor(width / 2);
  const bob = frame % 2 === 0 ? 0 : 1;

  // 腿
  fillRect(img, cx - 5, height - 14, 4, 12, dress);
  fillRect(img, cx + 1, height - 14, 4, 12, dress);
  // 裙
  for (let y = height - 26; y < height - 12; y++) {
    const halfW = 6 + (y - (height - 26)) * 0.9;
    fillRect(img, Math.floor(cx - halfW), y, Math.floor(halfW * 2), 1, dress);
  }
  // 上身
  fillRect(img, cx - 6, height - 40 + bob, 12, 16, dress);
  // 手臂
  fillRect(img, cx - 10, height - 38 + bob, 4, 13, skin);
  fillRect(img, cx + 6, height - 38 + bob, 4, 13, skin);
  // 头
  fillCircle(img, cx, height - 48 + bob, 8, skin);
  // 头发
  fillCircle(img, cx, height - 52 + bob, 9, hair);
  fillRect(img, cx - 9, height - 52 + bob, 3, 20, hair);
  fillRect(img, cx + 6, height - 52 + bob, 3, 20, hair);
  // 蝴蝶结
  fillRect(img, cx - 9, height - 60 + bob, 7, 5, ribbon);
  fillRect(img, cx + 2, height - 60 + bob, 7, 5, ribbon);
  // 眼睛
  fillRect(img, cx - 4, height - 49 + bob, 2, 2, [30, 30, 40, 255]);
  fillRect(img, cx + 2, height - 49 + bob, 2, 2, [30, 30, 40, 255]);
  return img;
}

function drawBullet(size: number, color: readonly number[], ring: readonly number[]): RawImage {
  const img = createCanvas(size, size);
  const c = Math.floor(size / 2);
  const r = Math.floor(size / 2) - 1;
  fillCircle(img, c, c, r, ring);
  fillCircle(img, c, c, Math.max(1, r - 2), color);
  fillCircle(img, c - Math.max(1, Math.floor(r / 3)), c - Math.max(1, Math.floor(r / 3)), Math.max(1, Math.floor(r / 4)), [255, 255, 255, 230]);
  return img;
}

function drawEffect(size: number, color: readonly number[], phase: number): RawImage {
  const img = createCanvas(size, size);
  const c = Math.floor(size / 2);
  const r = Math.floor(size / 2) - 2;
  fillRing(img, c, c, r - phase * 2, 2 + phase, color);
  fillCircle(img, c, c, Math.max(1, 3 - phase), [255, 255, 255, 160]);
  return img;
}

function drawPortrait(width: number, height: number, hair: readonly number[], dress: readonly number[], ribbon: readonly number[]): RawImage {
  const img = createCanvas(width, height);
  const cx = Math.floor(width / 2);
  // 背景光晕
  for (let r = Math.floor(width * 0.45); r > 0; r -= 2) {
    fillCircle(img, cx, Math.floor(height * 0.4), r, [hair[0], hair[1], hair[2], 12]);
  }
  // 身体
  fillRect(img, cx - 30, height - 80, 60, 80, dress);
  // 头
  fillCircle(img, cx, height - 110, 30, [252, 224, 205, 255]);
  // 头发
  fillCircle(img, cx, height - 122, 34, hair);
  fillRect(img, cx - 34, height - 122, 12, 70, hair);
  fillRect(img, cx + 22, height - 122, 12, 70, hair);
  // 蝴蝶结
  fillCircle(img, cx - 22, height - 146, 12, ribbon);
  fillCircle(img, cx + 22, height - 146, 12, ribbon);
  // 眼睛
  fillRect(img, cx - 14, height - 116, 7, 9, [70, 40, 60, 255]);
  fillRect(img, cx + 7, height - 116, 7, 9, [70, 40, 60, 255]);
  // 高光
  fillRect(img, cx - 12, height - 114, 3, 3, [255, 255, 255, 255]);
  fillRect(img, cx + 9, height - 114, 3, 3, [255, 255, 255, 255]);
  return img;
}

// ---------------------------------------------------------------- 格式构造

interface SpriteSpec {
  image: RawImage;
  /** 写入 ANM 数据区的图片字节（PNG 或 JPEG） */
  data: Buffer;
}

interface ScriptSpec {
  id: number;
  frames: { spriteId: number; duration: number }[];
}

/** 构造 TH06 布局的 ANM 文件 */
function buildAnm(specs: SpriteSpec[], scripts: ScriptSpec[]): Buffer {
  const HEADER = 0x20;
  const ENTRY = 32;
  const n = specs.length;
  const spriteTableEnd = HEADER + n * ENTRY;
  const scriptSize = scripts.reduce((a, s) => a + 16 + s.frames.length * 8, 0);
  const imageStart = spriteTableEnd + scriptSize;

  const offsets: number[] = [];
  let cursor = imageStart;
  for (const s of specs) {
    offsets.push(cursor);
    cursor += s.data.length;
  }

  const buf = Buffer.alloc(cursor);
  const maxW = Math.max(...specs.map((s) => s.image.width));
  const maxH = Math.max(...specs.map((s) => s.image.height));

  buf.writeUInt32LE(n, 0);
  buf.writeUInt32LE(scripts.length, 4);
  buf.writeUInt32LE(0, 8);
  buf.writeUInt32LE(maxW, 12);
  buf.writeUInt32LE(maxH, 16);
  buf.writeUInt32LE(5, 20);
  buf.writeUInt32LE(0, 24);
  buf.writeUInt32LE(0, 28);

  for (let i = 0; i < n; i++) {
    const p = HEADER + i * ENTRY;
    buf.writeUInt32LE(i, p);
    buf.writeUInt32LE(specs[i].image.width, p + 4);
    buf.writeUInt32LE(specs[i].image.height, p + 8);
    buf.writeUInt32LE(offsets[i], p + 12);
    buf.writeUInt32LE(5, p + 16);
    buf.writeInt16LE(0, p + 20);
    buf.writeInt16LE(0, p + 22);
    buf.writeInt16LE(specs[i].image.width - 1, p + 24);
    buf.writeInt16LE(specs[i].image.height - 1, p + 26);
    buf.writeUInt32LE(0, p + 28);
  }

  let sp = spriteTableEnd;
  for (const s of scripts) {
    buf.writeUInt16LE(s.id, sp);
    buf.writeUInt16LE(0, sp + 2);
    buf.writeUInt16LE(0, sp + 4);
    buf.writeUInt16LE(0, sp + 6);
    buf.writeUInt32LE(s.frames.length, sp + 8);
    buf.writeUInt32LE(0, sp + 12);
    let fp = sp + 16;
    for (const f of s.frames) {
      buf.writeUInt32LE(f.spriteId, fp);
      buf.writeUInt32LE(f.duration, fp + 4);
      fp += 8;
    }
    sp = fp;
  }

  for (let i = 0; i < n; i++) specs[i].data.copy(buf, offsets[i]);
  return buf;
}

function checksumOf(buf: Buffer): number {
  let s = 0;
  for (const b of buf) s = (s + b) >>> 0;
  return s;
}

/**
 * 构造 **PBG3**（红魔乡）格式的 DAT 归档。
 *
 * 布局与 thtk 写回结果一致：
 *   [0x00] 魔数 "PBG3" + 条目数(变长) + 索引表偏移(变长) —— 预留 13 字节，位流编码
 *   [0x0D ...] 各条目 LZSS 压缩数据，首尾相接
 *   [tableOffset ...] 位流索引表：每条 { unknown1, unknown2, checksum, offset, size, name }
 */
function buildDat(files: { name: string; data: Buffer }[]): Buffer {
  const HEADER_RESERVE = 13;
  const compressed = files.map((f) => {
    const c = lzssCompress(f.data);
    // 往返自检：解压结果必须与原文逐字节一致，否则立即暴露压缩器缺陷
    const back = lzssDecompress(c, f.data.length);
    if (!back.equals(f.data)) {
      throw new Error(`LZSS 往返校验失败：${f.name}（原始 ${f.data.length}B / 压缩 ${c.length}B）`);
    }
    return c;
  });

  let cursor = HEADER_RESERVE;
  const metas = files.map((f, i) => {
    const m = {
      name: f.name,
      offset: cursor,
      size: f.data.length,
      checksum: checksumOf(compressed[i]),
    };
    cursor += compressed[i].length;
    return m;
  });
  const tableOffset = cursor;

  const bw = new BitWriter();
  for (const m of metas) {
    bw.writeVariableUInt(0); // unknown1
    bw.writeVariableUInt(0); // unknown2
    bw.writeVariableUInt(m.checksum);
    bw.writeVariableUInt(m.offset);
    bw.writeVariableUInt(m.size);
    bw.writeCString(m.name);
  }
  const table = bw.finish();

  const hw = new BitWriter();
  for (const ch of 'PBG3') hw.write(8, ch.charCodeAt(0));
  hw.writeVariableUInt(files.length);
  hw.writeVariableUInt(tableOffset);
  const header = hw.finish();
  if (header.length > HEADER_RESERVE) {
    throw new Error(`PBG3 头部超出预留空间：${header.length} > ${HEADER_RESERVE}`);
  }

  const out = Buffer.alloc(tableOffset + table.length);
  header.copy(out, 0);
  compressed.forEach((c, i) => c.copy(out, metas[i].offset));
  table.copy(out, tableOffset);
  return out;
}

/** 构造 WAV（PCM 16bit 单声道） */
function buildWav(sampleCount: number, sampleRate: number, freq: number, amplitude = 0.25): Buffer {
  const dataSize = sampleCount * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < sampleCount; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, i / 800) * Math.min(1, (sampleCount - i) / 2000);
    const v = Math.sin(2 * Math.PI * freq * t) * amplitude * env * 32767;
    buf.writeInt16LE(Math.round(v), 44 + i * 2);
  }
  return buf;
}

/** 构造 thbgm.dat（曲名/文件名成对字符串表 + 等长音频块） */
function buildThbgm(tracks: { title: string; fileName: string; wav: Buffer }[]): Buffer {
  const nameChunks: Buffer[] = [];
  for (const t of tracks) {
    nameChunks.push(Buffer.concat([Buffer.from(t.title, 'utf8'), Buffer.from([0])]));
    nameChunks.push(Buffer.concat([Buffer.from(t.fileName, 'latin1'), Buffer.from([0])]));
  }
  // 结尾空串标记
  nameChunks.push(Buffer.from([0]));

  const namesBuf = Buffer.concat(nameChunks);
  const dataStart = Math.ceil((namesBuf.length + 16) / 0x100) * 0x100;
  const trackSize = tracks[0].wav.length;
  const buf = Buffer.alloc(dataStart + trackSize * tracks.length);
  namesBuf.copy(buf, 0);
  tracks.forEach((t, i) => {
    t.wav.copy(buf, dataStart + i * trackSize);
  });
  return buf;
}

/**
 * 构造 ECL（红魔乡结构）。
 *
 *   header:  sub_count / main_offset / padding[2] = 0
 *   0x10:    subs_offsets[sub_count]
 *   主时间线与各子程序均为指令流：
 *     u32 frame_num / u16 opcode / u16 size / u16 rank_mask / u16 param_mask / params[]
 *   子程序以 frame_num=0xffffffff + opcode=0xffff 结束
 */
function buildEcl(): Buffer {
  const groups: Array<{ count: number; speed: number; angle: number }> = [
    { count: 32, speed: 2.6, angle: 0.0 },
    { count: 8, speed: 1.9, angle: 0.7 },
    { count: 1, speed: 6.2, angle: 3.14 },
    { count: 64, speed: 1.3, angle: 4.71 },
  ];

  const subCount = groups.length;
  const mainOffset = 16 + subCount * 4; // 0x20
  const mainSize = 0x28; // 两条 16 字节指令 + 2 字节终止标记
  const subStart = mainOffset + mainSize; // 0x48
  const subSize = 0x60;

  const buf = Buffer.alloc(subStart + subCount * subSize);

  buf.writeUInt32LE(subCount, 0);
  buf.writeUInt32LE(mainOffset, 4);
  buf.writeUInt32LE(0, 8);
  buf.writeUInt32LE(0, 12);

  const subOffsets: number[] = [];
  for (let i = 0; i < subCount; i++) {
    subOffsets.push(subStart + i * subSize);
    buf.writeUInt32LE(subOffsets[i], 16 + i * 4);
  }

  // 主时间线：两条 16 字节指令 + 0xffff 终止
  let p = mainOffset;
  for (const frame of [0, 60]) {
    buf.writeUInt16LE(frame, p);
    buf.writeUInt16LE(0, p + 2);
    buf.writeUInt16LE(0, p + 4);
    buf.writeUInt16LE(16, p + 6);
    buf.writeUInt32LE(0, p + 8);
    buf.writeUInt32LE(0, p + 12);
    p += 16;
  }
  buf.writeUInt16LE(0xffff, p);

  // 子程序：每个含两条弹幕指令（参数区为 u16 count + f32 speed + f32 angle）
  subOffsets.forEach((start, i) => {
    const g = groups[i];
    let q = start;
    for (const [frame, factor] of [
      [0, 1],
      [30, 1.5],
    ] as Array<[number, number]>) {
      const size = 12 + 10;
      buf.writeUInt32LE(frame, q);
      buf.writeUInt16LE(0x65 + i, q + 4);
      buf.writeUInt16LE(size, q + 6);
      buf.writeUInt16LE(0xffff, q + 8);
      buf.writeUInt16LE(0xff, q + 10);
      buf.writeUInt16LE(Math.max(1, Math.round(g.count / factor)), q + 12);
      buf.writeFloatLE(g.speed * factor, q + 14);
      buf.writeFloatLE(g.angle, q + 18);
      q += size;
    }
    // 终止标记
    buf.writeUInt32LE(0xffffffff, q);
    buf.writeUInt16LE(0xffff, q + 4);
    buf.writeUInt16LE(0x0c, q + 6);
    buf.writeUInt16LE(0, q + 8);
    buf.writeUInt16LE(0, q + 10);
  });

  return buf;
}

/** 构造 TH06 布局的 MSG 剧情文件 */
function buildMsg(lines: { time: number; text: string }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const l of lines) {
    const text = Buffer.from(l.text, 'utf8');
    const head = Buffer.alloc(8);
    head.writeUInt32LE(l.time, 0);
    head.writeUInt16LE(text.length, 4);
    head.writeUInt16LE(0, 6);
    chunks.push(head, text);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- 数据装配

function buildPlayerAnm(): Buffer {
  const skins: Array<{ skin: RGBA; hair: RGBA; dress: RGBA; ribbon: RGBA }> = [
    { skin: [252, 224, 205, 255], hair: [92, 60, 52, 255], dress: [225, 60, 70, 255], ribbon: [230, 70, 80, 255] }, // 红白巫女
    { skin: [250, 226, 210, 255], hair: [238, 214, 120, 255], dress: [60, 62, 78, 255], ribbon: [245, 245, 250, 255] }, // 黑白魔法使
  ];
  const specs: SpriteSpec[] = [];
  const scripts: ScriptSpec[] = [];

  let idx = 0;
  skins.forEach((sk, ci) => {
    const frameIds: number[] = [];
    for (let f = 0; f < 6; f++) {
      const img = drawCharacter(32, 48, sk.skin, sk.hair, sk.dress, sk.ribbon, f);
      // 红魔乡的 ANM 贴图为 JPEG 内嵌，此处保持一致以覆盖真实解码路径
      specs.push({ image: img, data: encodeJpegFromRGBA(img) });
      frameIds.push(idx++);
    }
    scripts.push({ id: ci, frames: frameIds.map((id) => ({ spriteId: id, duration: 8 })) });
  });

  return buildAnm(specs, scripts);
}

function buildBulletAnm(): Buffer {
  const palette: RGBA[] = [
    [240, 70, 80, 255],
    [90, 150, 245, 255],
    [110, 220, 130, 255],
    [245, 210, 90, 255],
    [190, 120, 240, 255],
  ];
  const specs: SpriteSpec[] = [];
  const scripts: ScriptSpec[] = [];
  let idx = 0;

  palette.forEach((color, ci) => {
    const frameIds: number[] = [];
    for (let phase = 0; phase < 4; phase++) {
      const dir = ((ci * 4 + phase) % 4) * 90;
      const img = drawBullet(16, color, [255, 255, 255, 200]);
      // 旋转指示缺口，便于观察朝向
      fillRect(img, 7, dir === 0 ? 0 : dir === 180 ? 14 : 7, dir === 90 || dir === 270 ? 2 : 2, dir === 90 || dir === 270 ? 16 : 2, [255, 255, 255, 255]);
      specs.push({ image: img, data: encodePng(img) });
      frameIds.push(idx++);
    }
    scripts.push({ id: ci, frames: frameIds.map((id) => ({ spriteId: id, duration: 4 })) });
  });

  return buildAnm(specs, scripts);
}

function buildEffectAnm(): Buffer {
  const colors: RGBA[] = [
    [255, 200, 120, 220],
    [160, 200, 255, 220],
    [255, 140, 200, 220],
  ];
  const specs: SpriteSpec[] = [];
  const scripts: ScriptSpec[] = [];
  let idx = 0;

  colors.forEach((c, ci) => {
    const frameIds: number[] = [];
    for (let phase = 0; phase < 6; phase++) {
      const img = drawEffect(48, c, phase);
      specs.push({ image: img, data: encodePng(img) });
      frameIds.push(idx++);
    }
    scripts.push({ id: ci, frames: frameIds.map((id) => ({ spriteId: id, duration: 3 })) });
  });

  return buildAnm(specs, scripts);
}

function buildFaceAnm(): Buffer {
  const chars = [
    { hair: [92, 60, 52, 255], dress: [225, 60, 70, 255], ribbon: [230, 70, 80, 255] },
    { hair: [238, 214, 120, 255], dress: [60, 62, 78, 255], ribbon: [245, 245, 250, 255] },
    { hair: [120, 200, 180, 255], dress: [80, 120, 200, 255], ribbon: [140, 220, 200, 255] },
  ];
  const specs: SpriteSpec[] = [];
  const scripts: ScriptSpec[] = [];
  let idx = 0;

  chars.forEach((c, ci) => {
    const frameIds: number[] = [];
    for (let f = 0; f < 2; f++) {
      const img = drawPortrait(128, 192, c.hair, c.dress, c.ribbon);
      if (f === 1) fillRect(img, 0, 150, 128, 42, [0, 0, 0, 60]);
      specs.push({ image: img, data: encodePng(img) });
      frameIds.push(idx++);
    }
    scripts.push({ id: ci, frames: frameIds.map((id) => ({ spriteId: id, duration: 30 })) });
  });

  return buildAnm(specs, scripts);
}

function buildEnemyAnm(): Buffer {
  const variants: Array<{ dress: RGBA; hair: RGBA }> = [
    { dress: [110, 200, 140, 255], hair: [90, 180, 230, 255] },
    { dress: [200, 130, 220, 255], hair: [240, 200, 110, 255] },
  ];
  const specs: SpriteSpec[] = [];
  const scripts: ScriptSpec[] = [];
  let idx = 0;

  variants.forEach((v, ci) => {
    const frameIds: number[] = [];
    for (let f = 0; f < 4; f++) {
      const img = drawCharacter(24, 32, [250, 226, 210, 255], v.hair, v.dress, [255, 255, 255, 220], f);
      specs.push({ image: img, data: encodePng(img) });
      frameIds.push(idx++);
    }
    scripts.push({ id: ci, frames: frameIds.map((id) => ({ spriteId: id, duration: 6 })) });
  });

  return buildAnm(specs, scripts);
}

function buildMusicAnm(): Buffer {
  const specs: SpriteSpec[] = [];
  const scripts: ScriptSpec[] = [];
  const labels: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ];
  labels.forEach(([col, row], i) => {
    const img = createCanvas(24, 24);
    fillRect(img, 0, 0, 24, 24, [20, 22, 34, 200]);
    fillRect(img, 6 + col * 8, 4 + row * 8, 4, 16, [250, 240, 200, 255]);
    fillCircle(img, 5 + col * 8, 18 + row * 8, 3, [250, 240, 200, 255]);
    specs.push({ image: img, data: encodePng(img) });
    scripts.push({ id: i, frames: [{ spriteId: i, duration: 1 }] });
  });
  return buildAnm(specs, scripts);
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const demoRoot = ensureDir(FIXTURE_DIR);
  const dir = ensureDir(path.join(demoRoot, 'TouhouDemoTH06'));
  console.log(`\n[演示数据集] 输出目录：${dir}`);

  // 1) th06.exe（仅用于作品识别的占位文件，非可执行程序）
  fs.writeFileSync(path.join(dir, 'th06.exe'), Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.from(' TOUHOU RESOURCE STUDIO DEMO FIXTURE - NOT AN EXECUTABLE', 'latin1'), Buffer.alloc(2048)]));

  // 2) 各 ANM
  const files: { name: string; data: Buffer }[] = [
    { name: 'player00.anm', data: buildPlayerAnm() },
    { name: 'etama.anm', data: buildBulletAnm() },
    { name: 'effect.anm', data: buildEffectAnm() },
    { name: 'face_01.anm', data: buildFaceAnm() },
    { name: 'music.anm', data: buildMusicAnm() },
    { name: 'enemy.anm', data: buildEnemyAnm() },
    { name: 'ecldata', data: buildEcl() },
    {
      name: 'msg0.dat',
      data: buildMsg([
        { time: 60, text: 'ここは紅魔館の門の前。' },
        { time: 120, text: '門番「ここは通しませんよ」' },
        { time: 180, text: '霊夢「また面倒なところに来ちゃったわね」' },
        { time: 240, text: '魔理沙「華符『彩光乱舞』、見せてもらうぜ」' },
        { time: 300, text: '魔符『マスタースパーク』！' },
        { time: 360, text: '紅符『スカーレットシュート』' },
        { time: 420, text: '禁忌『レーヴァテイン』' },
        { time: 480, text: '奇術『ミスディレクション』' },
        { time: 540, text: '氷符『アイシクルフォール』' },
        { time: 600, text: '宵闇『ダークサイドオブザムーン』' },
      ]),
    },
    { name: 'stage01.std', data: Buffer.concat([Buffer.from([0x53, 0x54, 0x44, 0x00]), Buffer.alloc(512).map((_, i) => i % 251)]) },
  ];

  const dat = buildDat(files);
  fs.writeFileSync(path.join(dir, 'th06.dat'), dat);
  console.log(`[演示数据集] th06.dat 生成完毕：${(dat.length / 1024).toFixed(1)} KB，含 ${files.length} 个条目`);

  // 3) thbgm.dat
  const bgm = buildThbgm([
    { title: '赤より紅い夢', fileName: 'th06_01.wav', wav: buildWav(22050, 22050, 392) },
    { title: 'ほおずきみたいに紅い魂', fileName: 'th06_02.wav', wav: buildWav(22050, 22050, 440) },
    { title: 'U.N.オーエンは彼女なのか？', fileName: 'th06_03.wav', wav: buildWav(22050, 22050, 523) },
  ]);
  fs.writeFileSync(path.join(dir, 'thbgm.dat'), bgm);
  console.log(`[演示数据集] thbgm.dat 生成完毕：${(bgm.length / 1024).toFixed(1)} KB，含 3 首曲目`);

  // 4) 扫描入库
  const scan = scanDirectory(dir);
  console.log(`[演示数据集] 扫描识别到 ${scan.games.length} 个作品`);
  for (const g of scan.games) {
    upsertGame({
      code: g.id,
      name: `${g.name}（演示数据）`,
      nameJp: g.nameJp,
      shortName: g.name.replace(/^东方/, ''),
      version: g.version,
      engine: g.engine,
      year: g.year,
      path: g.path,
      exePath: g.exePath,
      kind: g.kind,
      note: '由演示数据集生成器合成，格式与真实 TH06 一致（PBG3 位流索引表 + LZSS 压缩）',
    });
    console.log(`  → ${g.id} ${g.name}  主归档: ${g.datFiles.map((d) => d.name).join(', ')}`);
  }

  // 5) 解包
  console.log('[演示数据集] 开始解包…');
  const summary = await extractGame(
    { gameId: 'TH06', datFiles: files.length ? [path.join(dir, 'th06.dat'), path.join(dir, 'thbgm.dat')] : [] },
    (phase, cur, total, msg) => {
      if (cur % 40 === 0 || phase !== 'sprites') process.stdout.write(`\r  [${phase}] ${cur}/${total} ${msg.slice(0, 60).padEnd(62)}`);
    },
  );
  process.stdout.write('\n');
  console.log(`[演示数据集] 解包完成：
  归档      ${summary.archives}
  素材      ${summary.assets}
  精灵      ${summary.sprites}
  图集      ${summary.sheets}
  BGM 曲目  ${summary.bgmTracks}
  文本行    ${summary.msgLines}
  弹幕模式  ${summary.patterns}
  角色      ${summary.characters}
  耗时      ${(summary.durationMs / 1000).toFixed(2)}s`);
  if (summary.warnings.length) {
    console.log('  警告:');
    for (const w of summary.warnings.slice(0, 10)) console.log(`    - ${w}`);
  }
  console.log('\n现在可以运行 npm run dev 启动工作台。\n');
}

main().catch((e) => {
  console.error('演示数据集生成失败：', e);
  process.exit(1);
});
