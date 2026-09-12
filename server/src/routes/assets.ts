import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  listAssets,
  getAsset,
  updateAsset,
  addTag,
  removeTag,
  listCategories,
  listTags,
  listAnmSprites,
  listAnimations,
  getAnimation,
  listTagsGrouped,
  listBosses,
  countByRole,
} from '../services/query.ts';
import { DATA_DIR } from '../core/paths.ts';
import { decodePng, encodePng, createCanvas, blitImage } from '../core/png.ts';
import { analyzeColors } from '../core/color.ts';
import { ROLE_LABELS, ROLE_HINTS } from '../services/classify.ts';

export const assetsRouter = Router();

assetsRouter.get('/assets', (req, res) => {
  const q = req.query as Record<string, string>;
  const result = listAssets({
    gameId: q.gameId,
    kind: q.kind,
    category: q.category,
    role: q.role,
    q: q.q,
    tag: q.tag,
    hasPreview: q.hasPreview === '1',
    limit: q.limit ? parseInt(q.limit, 10) : 60,
    offset: q.offset ? parseInt(q.offset, 10) : 0,
    sort: (q.sort as any) ?? 'name',
  });
  res.json(result);
});

assetsRouter.get('/assets/categories', (req, res) => {
  const gameId = (req.query as any).gameId as string | undefined;
  res.json({ items: listCategories(gameId) });
});

assetsRouter.get('/tags', (req, res) => {
  const gameId = (req.query as any).gameId as string | undefined;
  res.json({ items: listTags(gameId) });
});

/** 标签字典（含分组），来自 Tag 表而非资源上的 JSON 数组 */
assetsRouter.get('/tags/grouped', (_req, res) => {
  res.json({ items: listTagsGrouped() });
});

/** 动画列表（Animation 表），可按来源资源过滤 */
assetsRouter.get('/animations', (req, res) => {
  res.json({ items: listAnimations((req.query as any).resource) });
});

/** 单个动画及其帧序列（Animation_Frame，帧内携带精灵编码） */
assetsRouter.get('/animations/:id', (req, res) => {
  const anim = getAnimation(Number(req.params.id) || -1);
  if (!anim) {
    res.status(404).json({ error: '动画不存在' });
    return;
  }
  res.json(anim);
});

/** Boss 列表（Boss 表，含符卡数量） */
assetsRouter.get('/bosses', (req, res) => {
  res.json({ items: listBosses((req.query as any).gameId) });
});

/** 用途分组总览（对应第七节）：直接聚合，保证计数与筛选结果一致 */
assetsRouter.get('/roles', (req, res) => {
  const gameId = (req.query as any).gameId as string | undefined;
  const rows = countByRole(gameId) as Array<{ role: string; count: number }>;
  const items = rows.map((r) => ({
    role: r.role,
    label: ROLE_LABELS[r.role] ?? r.role,
    count: r.count,
    hint: ROLE_HINTS[r.role] ?? '',
  }));
  res.json({ items, total: rows.reduce((sum, r) => sum + r.count, 0) });
});

/** ANM 动画包拆出的全部精灵（动画分析器使用） */
assetsRouter.get('/assets/:id/sprites', (req, res) => {
  res.json(listAnmSprites(req.params.id));
});

assetsRouter.get('/assets/:id', (req, res) => {
  const asset = getAsset(req.params.id);
  if (!asset) {
    res.status(404).json({ error: '素材不存在' });
    return;
  }
  res.json(asset);
});

assetsRouter.patch('/assets/:id', (req, res) => {
  const updated = updateAsset(req.params.id, req.body ?? {});
  if (!updated) {
    res.status(404).json({ error: '素材不存在' });
    return;
  }
  res.json(updated);
});

assetsRouter.post('/assets/:id/tags', (req, res) => {
  const { tag } = req.body ?? {};
  if (!tag) {
    res.status(400).json({ error: '缺少 tag' });
    return;
  }
  res.json(addTag(req.params.id, String(tag)));
});

assetsRouter.delete('/assets/:id/tags/:tag', (req, res) => {
  res.json(removeTag(req.params.id, req.params.tag));
});

/** 读取 ANM / ECL 分析结果 JSON（由解包阶段生成） */
assetsRouter.get('/assets/:id/analysis', (req, res) => {
  const asset = getAsset(req.params.id) as any;
  if (!asset) {
    res.status(404).json({ error: '素材不存在' });
    return;
  }
  const dir = path.join(DATA_DIR, 'Game', asset.game_id, 'Analysis');
  if (!fs.existsSync(dir)) {
    res.status(404).json({ error: '该作品尚未生成分析数据' });
    return;
  }
  const candidates = fs.readdirSync(dir).filter((f) => f.startsWith(`${asset.id}_`));
  const out: Record<string, unknown> = {};
  for (const f of candidates) {
    try {
      out[f.replace(`${asset.id}_`, '').replace('.json', '')] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      /* ignore */
    }
  }
  if (Object.keys(out).length === 0) {
    res.status(404).json({ error: '未找到该素材的分析文件' });
    return;
  }
  res.json(out);
});

/** 颜色分析（按需计算，用于角色画像） */
assetsRouter.get('/assets/:id/colors', (req, res) => {
  const asset = getAsset(req.params.id) as any;
  if (!asset?.cache_path || !fs.existsSync(asset.cache_path)) {
    res.status(404).json({ error: '素材文件不存在' });
    return;
  }
  if (!asset.cache_path.toLowerCase().endsWith('.png')) {
    res.status(400).json({ error: '仅支持 PNG 素材的颜色分析（JPEG 需先转码）' });
    return;
  }
  const buf = fs.readFileSync(asset.cache_path);
  const img = decodePng(buf);
  if (!img) {
    res.status(400).json({ error: 'PNG 解码失败' });
    return;
  }
  const step = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 8192)));
  res.json(analyzeColors(img, step));
});

/**
 * 精灵表切片预览：把 sprite sheet 与单个精灵合成到一张对比图（用于动画分析器）
 */
assetsRouter.get('/assets/:id/thumbnail', (req, res) => {
  const asset = getAsset(req.params.id) as any;
  if (!asset?.cache_path || !fs.existsSync(asset.cache_path)) {
    res.status(404).end();
    return;
  }
  res.sendFile(path.resolve(asset.cache_path));
});

/** 生成带透明棋盘背景的预览图（PNG） */
assetsRouter.get('/assets/:id/preview', (req, res) => {
  const asset = getAsset(req.params.id) as any;
  if (!asset?.cache_path || !fs.existsSync(asset.cache_path)) {
    res.status(404).end();
    return;
  }
  const lower = String(asset.cache_path).toLowerCase();
  if (!lower.endsWith('.png')) {
    // 非 PNG 直接返回原文件
    res.sendFile(path.resolve(asset.cache_path));
    return;
  }
  try {
    const img = decodePng(fs.readFileSync(asset.cache_path));
    if (!img) {
      res.sendFile(path.resolve(asset.cache_path));
      return;
    }
    if (img.width > 1024 || img.height > 1024) {
      res.sendFile(path.resolve(asset.cache_path));
      return;
    }
    const canvas = createCanvas(img.width, img.height, [26, 28, 36, 255]);
    const cell = 8;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const check = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
        const i = (y * img.width + x) * 4;
        if (check) {
          canvas.data[i] = 34;
          canvas.data[i + 1] = 37;
          canvas.data[i + 2] = 48;
        }
      }
    }
    blitImage(canvas, img, 0, 0);
    res.type('image/png').send(encodePng(canvas));
  } catch {
    res.sendFile(path.resolve(asset.cache_path));
  }
});
