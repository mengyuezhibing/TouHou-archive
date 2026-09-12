/**
 * WD14 Tagger：动漫图片多标签自动识别。
 *
 * 模型来自 SmilingWolf 的 WD 系列（在 Danbooru 同人图上训练），
 * 标签体系包含东方角色（hakurei_reimu / kirisame_marisa / remilia_scarlet 等）。
 *
 * 需要明确的能力边界：
 *   · 这类模型学的是**同人插画**的视觉分布，对游戏内素材并非专精
 *   · 256×256 的立绘、背景、大特效图可能有参考价值
 *   · 30×32 的小精灵基本无效 —— 那点像素量不足以支撑角色判定
 *   因此调用方应只对达到尺寸阈值的素材打标。
 *
 * 预处理严格对齐官方实现（差异会导致输出完全失真）：
 *   1. alpha 合成到白底
 *   2. 保持宽高比，pad 成正方形（不是拉伸）
 *   3. 缩放到 448×448
 *   4. 通道顺序转 **BGR**，且**不除以 255**（模型直接吃 0-255）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA_DIR } from '../core/paths.ts';
import type { RawImage } from '../core/png.ts';

const require = createRequire(import.meta.url);

/** 模型文件目录：Data/Models/wd14 */
export const MODEL_DIR = path.join(DATA_DIR, 'Models', 'wd14');
const MODEL_PATH = path.join(MODEL_DIR, 'model.onnx');
const TAGS_PATH = path.join(MODEL_DIR, 'selected_tags.csv');

/** WD14 固定输入尺寸 */
export const INPUT_SIZE = 448;

export interface TagPrediction {
  name: string;
  score: number;
}

export interface TagResult {
  /** 全部命中标签，按分数降序 */
  tags: TagPrediction[];
  /** category=4 的角色标签 */
  characters: TagPrediction[];
  /** category=9 的分级标签 */
  rating: TagPrediction[];
  /** category=0 的一般标签 */
  general: TagPrediction[];
}

interface TagRow {
  name: string;
  category: number;
}

let session: any = null;
let tagRows: TagRow[] = [];
let inputName = 'input';
let outputName = 'output';

export function isModelReady(): boolean {
  return fs.existsSync(MODEL_PATH) && fs.existsSync(TAGS_PATH);
}

export function modelStatus(): { ready: boolean; modelPath: string; tagsPath: string; tagCount: number } {
  return {
    ready: isModelReady(),
    modelPath: MODEL_PATH,
    tagsPath: TAGS_PATH,
    tagCount: tagRows.length || (fs.existsSync(TAGS_PATH) ? countTagLines() : 0),
  };
}

function countTagLines(): number {
  try {
    return fs.readFileSync(TAGS_PATH, 'utf8').split('\n').filter((l) => l.trim()).length - 1;
  } catch {
    return 0;
  }
}

/** 加载标签表（tag_id,name,category,count） */
function loadTags(): TagRow[] {
  const text = fs.readFileSync(TAGS_PATH, 'utf8');
  const rows: TagRow[] = [];
  const lines = text.split('\n');
  // 跳过表头
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 3) continue;
    rows.push({ name: parts[1], category: Number(parts[2]) || 0 });
  }
  return rows;
}

/** 懒加载模型与会话（首次调用较慢，之后常驻内存） */
export async function loadTagger(): Promise<void> {
  if (session) return;
  if (!isModelReady()) {
    throw new Error(`WD14 模型未就绪，请确认 ${MODEL_PATH} 与 ${TAGS_PATH} 存在`);
  }
  const ort = require('onnxruntime-node');
  session = await ort.InferenceSession.create(MODEL_PATH, { executionProviders: ['cpu'] });
  inputName = session.inputNames?.[0] ?? 'input';
  outputName = session.outputNames?.[0] ?? 'output';
  tagRows = loadTags();
}

// ---------------------------------------------------------------- 预处理

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * 把任意 RGBA 图按官方流程转成模型输入张量。
 * 返回 NHWC 排布的 float32 数据（1 × 448 × 448 × 3）。
 */
function preprocess(img: RawImage): Float32Array {
  // 1. alpha 合成到白底
  const w = img.width;
  const h = img.height;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const a = img.data[o + 3] / 255;
    rgb[i * 3] = Math.round(img.data[o] * a + 255 * (1 - a));
    rgb[i * 3 + 1] = Math.round(img.data[o + 1] * a + 255 * (1 - a));
    rgb[i * 3 + 2] = Math.round(img.data[o + 2] * a + 255 * (1 - a));
  }

  // 2. pad 成正方形（居中，白底）
  const side = Math.max(w, h);
  const padX = Math.floor((side - w) / 2);
  const padY = Math.floor((side - h) / 2);

  // 3. 双线性缩放到 448×448，同时完成 pad 与 BGR 转换
  const out = new Float32Array(INPUT_SIZE * INPUT_SIZE * 3);
  const scale = side / INPUT_SIZE;
  for (let y = 0; y < INPUT_SIZE; y++) {
    for (let x = 0; x < INPUT_SIZE; x++) {
      // 映射回原图坐标（先减 pad 偏移，再按缩放比取样）
      const sx = (x + 0.5) * scale - 0.5 - padX;
      const sy = (y + 0.5) * scale - 0.5 - padY;
      let r = 255;
      let g = 255;
      let b = 255;

      if (sx >= -0.5 && sy >= -0.5 && sx <= w - 0.5 && sy <= h - 0.5) {
        const x0 = Math.max(0, Math.floor(sx));
        const y0 = Math.max(0, Math.floor(sy));
        const x1 = Math.min(w - 1, x0 + 1);
        const y1 = Math.min(h - 1, y0 + 1);
        const fx = Math.min(1, Math.max(0, sx - x0));
        const fy = Math.min(1, Math.max(0, sy - y0));

        const sample = (cx: number, cy: number, c: number) => rgb[(cy * w + cx) * 3 + c];
        for (let c = 0; c < 3; c++) {
          const v =
            sample(x0, y0, c) * (1 - fx) * (1 - fy) +
            sample(x1, y0, c) * fx * (1 - fy) +
            sample(x0, y1, c) * (1 - fx) * fy +
            sample(x1, y1, c) * fx * fy;
          if (c === 0) r = v;
          else if (c === 1) g = v;
          else b = v;
        }
      }

      // BGR 顺序，不做归一化（WD14 直接使用 0-255）
      const o = (y * INPUT_SIZE + x) * 3;
      out[o] = b;
      out[o + 1] = g;
      out[o + 2] = r;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 推理

export interface TagOptions {
  /** 一般标签的命中阈值，WD14 在插画上的惯例是 0.35 */
  threshold?: number;
  /**
   * 角色标签的阈值，默认显著高于一般标签。
   *
   * 原因：在训练分布之外的输入（游戏内素材）上，模型对角色标签的输出
   * 会退化成 logits≈0，即 sigmoid 后全部落在 0.50 附近 —— 那是「无信号」
   * 而不是「有点可能」。若沿用 0.35，会一次性命中上百个角色，毫无区分度。
   */
  characterThreshold?: number;
  /** 最多返回多少条一般标签 */
  maxGeneral?: number;
  /** 最多返回多少个角色标签 */
  maxCharacters?: number;
}

export async function tagImage(img: RawImage, opts: TagOptions = {}): Promise<TagResult> {
  await loadTagger();
  const ort = require('onnxruntime-node');
  const threshold = opts.threshold ?? 0.35;
  const characterThreshold = opts.characterThreshold ?? 0.65;
  const maxGeneral = opts.maxGeneral ?? 24;
  const maxCharacters = opts.maxCharacters ?? 8;

  const data = preprocess(img);
  const tensor = new ort.Tensor('float32', data, [1, INPUT_SIZE, INPUT_SIZE, 3]);
  const outputs = await session.run({ [inputName]: tensor });
  const logits = outputs[outputName].data as Float32Array;

  const all: TagPrediction[] = [];
  const characters: TagPrediction[] = [];
  const rating: TagPrediction[] = [];
  const general: TagPrediction[] = [];

  const n = Math.min(logits.length, tagRows.length);
  for (let i = 0; i < n; i++) {
    const score = sigmoid(logits[i]);
    const row = tagRows[i];
    const limit = row.category === 4 ? characterThreshold : threshold;
    if (score < limit) continue;
    const item = { name: row.name, score: Number(score.toFixed(4)) };
    all.push(item);
    if (row.category === 4) characters.push(item);
    else if (row.category === 9) rating.push(item);
    else general.push(item);
  }

  const byScore = (a: TagPrediction, b: TagPrediction) => b.score - a.score;
  all.sort(byScore);
  characters.sort(byScore);
  rating.sort(byScore);
  general.sort(byScore);

  return {
    tags: all,
    characters: characters.slice(0, maxCharacters),
    rating,
    general: general.slice(0, maxGeneral),
  };
}
