/**
 * ANM 预览渲染
 *
 * ANM 是动画脚本（精灵区域表 + 播放脚本），浏览器渲染不了二进制，
 * 此前 /preview 会把 .anm 原样发出导致列表里一片空白。这里把它渲染成
 * 一张「精灵图集预览」：从 ANM 引用的贴图上裁出各精灵区域，拼成网格图；
 * 贴图与裁片都找不到时退化为区域布局图，保证任何 ANM 都有可视结果。
 *
 * 工作区里的 ANM 全是 thtk 编译格式（64 字节头、贴图外置），贴图来源分三代：
 *   · 原版 TH06 —— 贴图没作为整体入库，导入时已按区域裁成
 *     `<同名>_<4位序号>.png` 精灵文件，直接按序号取用
 *   · TH06NC —— 贴图是 BC7 DDS（ANM 里引用的还是旧 .png 名，靠 basename
 *     匹配到实际文件），经 preview 服务转码后按区域裁剪，坐标按比例缩放
 *   · 两者皆缺 —— 区域布局图兜底
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/index.ts';
import { DATA_DIR } from '../core/paths.ts';
import { parseThtkAnm, type ThtkAnmInfo } from '../formats/anm.ts';
import {
  blitImage,
  createCanvas,
  cropImage,
  decodePng,
  encodePng,
  type RawImage,
} from '../core/png.ts';
import { ensureRasterPreview, needsTranscode } from './preview.ts';

const CACHE_DIR = path.join(DATA_DIR, 'Cache', 'previews');

/** 精灵网格：最多取前 12 个非空区域，4 列，单元格 220px */
const MAX_SPRITES = 12;
const COLS = 4;
const CELL = 220;
const GAP = 10;
const MARGIN = 14;

/* ---------------------------------------------------------------- 资源定位 */

/**
 * 把游戏引用解析成 resource.game_id 实际存储的数字 id。
 * 调用方传来的可能是 game.code（如 'TH06'，API 映射层的形态）或数字 id。
 */
const numericIdCache = new Map<string, number>();

function toNumericGameId(ref: number | string): number | null {
  if (typeof ref === 'number') return Number.isFinite(ref) ? ref : null;
  const cached = numericIdCache.get(ref);
  if (cached !== undefined) return cached;
  const row = db.prepare('SELECT id FROM game WHERE code = ?').get(ref) as
    | { id: number }
    | undefined;
  if (row?.id !== undefined) {
    numericIdCache.set(ref, row.id);
    return row.id;
  }
  return null;
}

/**
 * gameId → 库内图像资源索引，进程内缓存一次。
 *   byBase         basename(无扩展名) → 完整贴图路径（etama4 → etama4.dds）
 *   spritesByBase  `<base>_<4位序号>` → 按序号排列的精灵裁片（title04_0000.png …）
 */
interface TexIndex {
  byBase: Map<string, string[]>;
  spritesByBase: Map<string, Array<{ idx: number; path: string }>>;
}

const texIndexCache = new Map<number, TexIndex>();

function textureIndex(gameId: number | null): TexIndex {
  if (gameId === null) return { byBase: new Map(), spritesByBase: new Map() };
  const cached = texIndexCache.get(gameId);
  if (cached) return cached;
  const idx: TexIndex = { byBase: new Map(), spritesByBase: new Map() };
  const rows = db
    .prepare(
      `SELECT path, filename FROM resource
        WHERE game_id = ? AND path IS NOT NULL
          AND ext IN ('.png','.dds','.jpg','.bmp','.tga')`,
    )
    .all(gameId) as Array<{ path: string; filename: string }>;
  for (const r of rows) {
    // 两个代际的落盘命名不一致：TH06NC 的缓存文件保留原始名（etama4.dds），
    // TH06 的部分缓存文件被重命名成 code（TH06_BACKGROUND_0034.png）。
    // 因此 basename 同时取自 filename（原始名）与路径本身，ANM 两侧都能命中。
    const names = new Set<string>();
    const fileBase = (r.filename ?? '').replace(/\.[^.]+$/, '').toLowerCase();
    const pathBase = path.basename(r.path).replace(/\.[^.]+$/, '').toLowerCase();
    if (fileBase) names.add(fileBase);
    if (pathBase) names.add(pathBase);

    for (const base of names) {
      const arr = idx.byBase.get(base);
      if (arr) {
        if (!arr.includes(r.path)) arr.push(r.path);
      } else idx.byBase.set(base, [r.path]);

      const m = base.match(/^(.+)_\d{4}$/);
      if (m && /^\d{4}$/.test(base.slice(base.length - 4))) {
        const owner = m[1];
        const list = idx.spritesByBase.get(owner) ?? [];
        list.push({ idx: parseInt(base.slice(-4), 10), path: r.path });
        idx.spritesByBase.set(owner, list);
      }
    }
  }
  for (const list of idx.spritesByBase.values()) list.sort((a, b) => a.idx - b.idx);
  texIndexCache.set(gameId, idx);
  return idx;
}

/**
 * 找 ANM 引用的完整贴图。
 * 优先级：外置引用名（basename 匹配，同目录优先）→ 与 ANM 同名的兄弟贴图。
 * 供 ANM 预览渲染与导入脚本（精灵提取）共用。
 */
export function resolveTexture(
  anmPath: string,
  externalName: string | null,
  gameId: number | null,
): string | null {
  const dir = path.dirname(anmPath);
  const cands: Array<{ p: string; sameDir: boolean }> = [];
  const push = (p: string) => {
    if (p && fs.existsSync(p) && !cands.some((c) => c.p === p)) {
      cands.push({ p, sameDir: path.dirname(p) === dir });
    }
  };

  if (externalName) {
    const base = path.basename(externalName).replace(/\.[^.]+$/, '').toLowerCase();
    const hits = textureIndex(gameId).byBase.get(base) ?? [];
    for (const h of [...hits].sort((a, b) =>
      (path.dirname(a) === dir ? 0 : 1) - (path.dirname(b) === dir ? 0 : 1) || a.length - b.length,
    )) {
      push(h);
    }
  }

  // 兄弟贴图：xxx.anm + xxx.png/dds 成对命名（重编译版惯例）
  const anmBase = path.basename(anmPath).replace(/\.anm$/i, '');
  for (const ext of ['.png', '.dds', '.jpg', '.bmp']) {
    push(path.join(dir, anmBase + ext));
  }

  return cands[0]?.p ?? null;
}

/** 找导入时已裁好的精灵序列（原版 TH06 的存储形态） */
function resolveSprites(anmBase: string, gameId: number | null): string[] {
  return (textureIndex(gameId).spritesByBase.get(anmBase.toLowerCase()) ?? []).map((s) => s.path);
}

/* ---------------------------------------------------------------- 图像工具 */

/** 最近邻缩放（预览图够用，保持像素锐利） */
function scaleImage(src: RawImage, tw: number, th: number): RawImage {
  if (src.width === tw && src.height === th) return src;
  const out = createCanvas(tw, th);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / th));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / tw));
      const si = (sy * src.width + sx) * 4;
      const di = (y * tw + x) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

function fitInto(w: number, h: number, maxSide: number): [number, number] {
  if (w <= maxSide && h <= maxSide) return [w, h];
  return w >= h
    ? [maxSide, Math.max(1, Math.round((h * maxSide) / w))]
    : [Math.max(1, Math.round((w * maxSide) / h)), maxSide];
}

/** 加载图像为 RGBA。PNG 走全分辨率；DDS 等走转码缓存（≤1024）。供精灵提取复用 */
export async function loadRaster(file: string): Promise<RawImage | null> {
  let f = file;
  if (needsTranscode(file)) {
    const cached = await ensureRasterPreview(file);
    if (!cached) return null;
    f = cached;
  }
  try {
    return decodePng(fs.readFileSync(f));
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- 渲染 */

/** 深色棋盘底（与图片预览同款配色） */
function checkerboard(img: RawImage): void {
  const cell = 8;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if ((Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0) {
        const i = (y * img.width + x) * 4;
        img.data[i] = 34;
        img.data[i + 1] = 37;
        img.data[i + 2] = 48;
        img.data[i + 3] = 255;
      }
    }
  }
}

/** 精灵网格：把若干张图拼成 4 列布局 */
function composeGrid(images: RawImage[]): RawImage {
  const picks = images.slice(0, MAX_SPRITES);
  if (picks.length === 0) picks.push(createCanvas(64, 64));
  const rows = Math.ceil(picks.length / COLS);
  const canvas = createCanvas(
    MARGIN * 2 + COLS * CELL + (COLS - 1) * GAP,
    MARGIN * 2 + rows * CELL + (rows - 1) * GAP,
    [26, 28, 36, 255],
  );
  checkerboard(canvas);
  picks.forEach((sprite, i) => {
    const [tw, th] = fitInto(sprite.width, sprite.height, CELL);
    const s = scaleImage(sprite, tw, th);
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    blitImage(
      canvas,
      s,
      MARGIN + col * (CELL + GAP) + Math.floor((CELL - tw) / 2),
      MARGIN + row * (CELL + GAP) + Math.floor((CELL - th) / 2),
    );
  });
  return canvas;
}

/** 从完整贴图按区域表裁精灵再拼网格 */
function composeSheet(
  tex: RawImage,
  scale: number,
  regions: ThtkAnmInfo['regions'],
): RawImage {
  const crops: RawImage[] = [];
  for (const r of regions) {
    if (crops.length >= MAX_SPRITES) break;
    const w = Math.round(r.w * scale);
    const h = Math.round(r.h * scale);
    if (w < 2 || h < 2) continue;
    crops.push(cropImage(tex, Math.round(r.x * scale), Math.round(r.y * scale), w, h));
  }
  return composeGrid(crops);
}

/** 布局图：贴图与裁片都缺时画出区域框，至少能看出精灵分布 */
function composeLayout(info: ThtkAnmInfo): RawImage {
  const [w, h] = fitInto(Math.max(1, info.width), Math.max(1, info.height), 512);
  const canvas = createCanvas(w, h, [26, 28, 36, 255]);
  checkerboard(canvas);
  const sx = w / info.width;
  const sy = h / info.height;
  for (const r of info.regions) {
    const x = Math.round(r.x * sx);
    const y = Math.round(r.y * sy);
    const rw = Math.max(1, Math.round(r.w * sx));
    const rh = Math.max(1, Math.round(r.h * sy));
    for (let j = 0; j < rh; j++) {
      for (let i = 0; i < rw; i++) {
        // 描边 + 稀疏填充，区域密集时也能看清边界
        const edge = i === 0 || j === 0 || i === rw - 1 || j === rh - 1;
        if (!edge && (i + j) % 8 !== 0) continue;
        const px = x + i;
        const py = y + j;
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const o = (py * w + px) * 4;
        canvas.data[o] = edge ? 126 : 40;
        canvas.data[o + 1] = edge ? 172 : 92;
        canvas.data[o + 2] = edge ? 255 : 140;
        canvas.data[o + 3] = 255;
      }
    }
  }
  return canvas;
}

/* ---------------------------------------------------------------- 缓存与入口 */

const inFlight = new Map<string, Promise<Buffer | null>>();

function cachePathFor(anmPath: string, sourceKey: string): string {
  const key = crypto
    .createHash('sha1')
    .update(
      ['anm-v3', path.resolve(anmPath), fs.statSync(anmPath).mtimeMs, sourceKey].join('|'),
    )
    .digest('hex');
  return path.join(CACHE_DIR, `${key}.png`);
}

/**
 * 渲染一个 ANM 的预览 PNG。
 * entryName 是资源的原始文件名（如 title04.anm）——精灵裁片按它命名
 * （title04_0000.png…），而缓存文件可能是重命名后的 code（TH06_UI_0100.anm）。
 * 返回 PNG 字节；ANM 解析失败返回 null（由调用方决定如何应答）。
 */
export async function renderAnmPreview(
  anmPath: string,
  gameRef: number | string,
  entryName?: string,
): Promise<Buffer | null> {
  let info: ThtkAnmInfo | null;
  try {
    info = parseThtkAnm(fs.readFileSync(anmPath));
  } catch {
    return null;
  }
  if (!info) return null;

  const anmBase = (entryName || path.basename(anmPath)).replace(/\.anm$/i, '');
  const gameId = toNumericGameId(gameRef);
  const texPath = resolveTexture(anmPath, info.externalName ?? info.externalAlphaName, gameId);
  const spritePaths = texPath ? [] : resolveSprites(anmBase, gameId);
  // 缓存键要能区分"贴图来源变了"：完整贴图用其路径+mtime，裁片用首张路径
  const sourceKey = texPath
    ? `${texPath}|${fs.statSync(texPath).mtimeMs}`
    : spritePaths.length
      ? `sprites:${spritePaths[0]}|${spritePaths.length}`
      : '-';

  const cacheFile = cachePathFor(anmPath, sourceKey);
  if (fs.existsSync(cacheFile)) return fs.promises.readFile(cacheFile);

  const running = inFlight.get(cacheFile);
  if (running) return running;

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const task = (async () => {
    let png: Buffer;
    if (texPath) {
      const tex = await loadRaster(texPath);
      if (tex) {
        // 贴图实际尺寸可能小于 ANM 头声明（DDS 转码上限 1024），坐标按比例缩放
        const scale = info.width > 0 ? tex.width / info.width : 1;
        png = encodePng(composeSheet(tex, scale, info.regions));
      } else {
        png = encodePng(composeLayout(info));
      }
    } else {
      const imgs: RawImage[] = [];
      for (const p of spritePaths.slice(0, MAX_SPRITES)) {
        const img = await loadRaster(p);
        if (img) imgs.push(img);
      }
      png = imgs.length ? encodePng(composeGrid(imgs)) : encodePng(composeLayout(info));
    }
    const tmp = `${cacheFile}.tmp`;
    await fs.promises.writeFile(tmp, png);
    await fs.promises.rename(tmp, cacheFile);
    return png;
  })()
    .catch((err) => {
      console.error(`  [anm-preview] ${path.basename(anmPath)} 渲染失败: ${err?.message ?? err}`);
      return null;
    })
    .finally(() => inFlight.delete(cacheFile));

  inFlight.set(cacheFile, task);
  return task;
}
