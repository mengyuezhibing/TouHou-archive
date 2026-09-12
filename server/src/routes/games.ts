import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { scanDirectory, listSupportedTitles } from '../services/scanner.ts';
import { listGames, getGame, upsertGame, deleteGame, listArchives, getDashboard } from '../services/query.ts';
import { runAsJob, getJob, listJobs } from '../services/jobs.ts';
import { extractGame, DEFAULT_MODES, type ExtractModes } from '../services/extractor.ts';
import { findTitleById } from '../data/titles.ts';
import { inspectArchive, inspectEntry, extractEntryData } from '../services/inspector.ts';
import { indexLooseFiles } from '../services/loosefiles.ts';
import { autoClassify } from '../services/autoclassify.ts';
import { identifyCharacters } from '../services/identify.ts';
import { db } from '../db/index.ts';
import { detectMagic } from '../core/magic.ts';
import { parseAnm, extractSpriteImage } from '../formats/anm.ts';

export const gamesRouter = Router();

/** 支持的作品清单 */
gamesRouter.get('/titles', (_req, res) => {
  res.json({ items: listSupportedTitles() });
});

/** 扫描目录，识别东方作品 */
gamesRouter.post('/games/scan', (req, res) => {
  const { path: dir, import: doImport } = req.body ?? {};
  if (!dir || typeof dir !== 'string') {
    res.status(400).json({ error: '缺少 path 参数' });
    return;
  }
  if (!fs.existsSync(dir)) {
    res.status(400).json({ error: `目录不存在：${dir}` });
    return;
  }
  const result = scanDirectory(dir);

  if (doImport !== false) {
    for (const g of result.games) {
      upsertGame({
        code: g.id,
        name: g.name,
        nameJp: g.nameJp,
        shortName: g.name.replace(/^东方/, ''),
        version: g.version,
        engine: g.engine,
        year: g.year,
        path: g.path,
        exePath: g.exePath,
        kind: g.kind,
        note: g.note,
      });
    }
  }
  res.json(result);
});

/** 手动登记一个作品 */
gamesRouter.post('/games', (req, res) => {
  const { id, path: dir } = req.body ?? {};
  const title = findTitleById(String(id ?? ''));
  if (!title) {
    res.status(400).json({ error: `未知作品编号：${id}` });
    return;
  }
  const game = upsertGame({
    code: title.id,
    name: title.name,
    nameJp: title.nameJp,
    shortName: title.name.replace(/^东方/, ''),
    version: title.id,
    engine: title.engine,
    year: title.year,
    path: dir ?? '',
    kind: title.kind,
    note: title.note,
  });
  res.json(game);
});

gamesRouter.get('/games', (_req, res) => {
  res.json({ items: listGames() });
});

gamesRouter.get('/games/:id', (req, res) => {
  const game = getGame(req.params.id);
  if (!game) {
    res.status(404).json({ error: '作品不存在' });
    return;
  }
  const archives = listArchives(req.params.id);
  const title = findTitleById(req.params.id);
  res.json({ game, archives, title });
});

gamesRouter.delete('/games/:id', (req, res) => {
  deleteGame(req.params.id);
  res.json({ ok: true });
});

/** 列出目录下的可解包文件（用于解包工具界面的"扫描"） */
gamesRouter.post('/games/:id/probe', (req, res) => {
  const game = getGame(req.params.id);
  if (!game) {
    res.status(404).json({ error: '作品不存在' });
    return;
  }
  const dir = String((req.body ?? {}).path ?? (game as any).path ?? '');
  if (!dir || !fs.existsSync(dir)) {
    res.status(400).json({ error: `目录不存在：${dir}` });
    return;
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && !e.name.startsWith('._'))
    .map((e) => {
      const full = path.join(dir, e.name);
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        /* ignore */
      }
      const lower = e.name.toLowerCase();
      const isDat = lower.endsWith('.dat');
      const isBgm = /thbgm|bgm/i.test(e.name);
      return {
        name: e.name,
        path: full,
        size,
        isDat,
        isBgm,
        isExe: lower.endsWith('.exe'),
        selectable: isDat && !isBgm,
      };
    })
    .sort((a, b) => b.size - a.size);
  res.json({ dir, files });
});

/** 启动解包任务（对应 4.3 解包工具模块） */
gamesRouter.post('/games/:id/extract', (req, res) => {
  const game = getGame(req.params.id);
  if (!game) {
    res.status(404).json({ error: '作品不存在' });
    return;
  }
  const body = (req.body ?? {}) as { files?: string[]; modes?: Partial<ExtractModes>; preset?: string; maxSpritesPerAnm?: number };
  const gamePath = (game as any).path as string;

  let files = body.files ?? [];
  if (files.length === 0 && gamePath && fs.existsSync(gamePath)) {
    files = fs
      .readdirSync(gamePath)
      .filter((f) => f.toLowerCase().endsWith('.dat'))
      .map((f) => path.join(gamePath, f));
  }
  if (files.length === 0) {
    res.status(400).json({ error: '没有可解包的文件，请先在扫描步骤中确认游戏目录' });
    return;
  }

  // 预设模式
  const presets: Record<string, Partial<ExtractModes>> = {
    all: DEFAULT_MODES,
    images: { images: true, sprites: true, sheets: true, audio: false, text: false, scripts: false },
    danmaku: { images: false, sprites: false, sheets: false, audio: false, text: false, scripts: true },
    audio: { images: false, sprites: false, sheets: false, audio: true, text: false, scripts: false },
    text: { images: false, sprites: false, sheets: false, audio: false, text: true, scripts: false },
  };
  const modes = { ...(presets[body.preset ?? 'all'] ?? DEFAULT_MODES), ...(body.modes ?? {}) };

  const jobPromise = runAsJob(req.params.id, 'extract', async (report) => {
    const summary = await extractGame(
      { gameId: req.params.id, datFiles: files, modes, maxSpritesPerAnm: body.maxSpritesPerAnm },
      (phase, current, total, message) => report(phase, current, total, message),
    );
    return {
      stats: {
        archives: summary.archives,
        assets: summary.assets,
        sprites: summary.sprites,
        sheets: summary.sheets,
        bgmTracks: summary.bgmTracks,
        msgLines: summary.msgLines,
        patterns: summary.patterns,
        characters: summary.characters,
        warnings: summary.warnings.slice(0, 30),
      },
      message: `解包完成：${summary.assets} 项素材 / ${summary.sprites} 张精灵 / ${summary.sheets} 张图集`,
    };
  });

  void jobPromise.then((job) => {
    res.json({ jobId: job.id, files: files.length, modes });
  });
});

gamesRouter.get('/jobs', (_req, res) => {
  res.json({ items: listJobs() });
});

gamesRouter.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  res.json(job);
});

gamesRouter.get('/dashboard', (_req, res) => {
  res.json(getDashboard());
});

/**
 * 自动分类填充：把已索引资源归入角色库 / 怪物库 / Boss / 符卡库 / 文本分析。
 * 依据文件名规律而非 ANM 解析，因此在 ANM 被重打包的版本上同样有效。
 */
gamesRouter.post('/games/:id/auto-classify', (req, res) => {
  const game = getGame(req.params.id);
  if (!game) {
    res.status(404).json({ error: '作品不存在' });
    return;
  }
  res.json(autoClassify(req.params.id));
});

/**
 * 角色身份识别：依据符卡名（版本间稳定的锚点）反查角色，
 * 改名并建立 符卡 / 弹幕 / 动画 的关联。
 */
gamesRouter.post('/games/:id/identify', (req, res) => {
  const game = getGame(req.params.id);
  if (!game) {
    res.status(404).json({ error: '作品不存在' });
    return;
  }
  res.json(identifyCharacters(req.params.id));
});

/** 索引游戏目录下的独立文件（BGM 逐曲 wav、独立 se 等），原地引用不复制 */
gamesRouter.post('/games/:id/index-loose', (req, res) => {
  const game = getGame(req.params.id);
  if (!game) {
    res.status(404).json({ error: '作品不存在' });
    return;
  }
  const body = (req.body ?? {}) as { dir?: string; includeImages?: boolean };
  const dir = body.dir || (game as any).path;
  if (!dir || !fs.existsSync(dir)) {
    res.status(400).json({ error: `目录不存在：${dir ?? '(未设置游戏路径)'}` });
    return;
  }
  const result = indexLooseFiles(req.params.id, dir, { includeImages: body.includeImages === true });
  res.json(result);
});

/**
 * 本地文件访问。
 * 散落资源是原地引用的，不在 Data 缓存目录内，因此需要一个受控的读取入口。
 * 安全约束：只允许读取**已登记作品根目录之下**的文件。
 */
gamesRouter.get('/local-file', (req, res) => {
  const target = String((req.query as Record<string, string>).path ?? '');
  if (!target) {
    res.status(400).json({ error: '缺少 path' });
    return;
  }
  const roots = (db.prepare('SELECT root_path FROM game WHERE root_path IS NOT NULL').all() as Array<{ root_path: string }>).map(
    (r) => r.root_path,
  );
  const abs = path.resolve(target);
  const allowed = roots.some((root) => root && abs.startsWith(path.resolve(root) + path.sep));
  if (!allowed) {
    res.status(403).json({ error: '路径不在已登记的游戏目录内' });
    return;
  }
  if (!fs.existsSync(abs)) {
    res.status(404).json({ error: '文件不存在' });
    return;
  }
  res.sendFile(abs);
});

// ---------------------------------------------------------------- 归档检视（不解包）

/** 检视归档索引：列出全部条目（对应 UI 文档第 7 节文件查看器的资源树） */
gamesRouter.post('/archives/inspect', (req, res) => {
  const { path: filePath, gameId } = (req.body ?? {}) as { path?: string; gameId?: string };
  if (!filePath) {
    res.status(400).json({ error: '缺少 path 参数' });
    return;
  }
  const result = inspectArchive(String(filePath), gameId);
  if (!result) {
    res.status(404).json({ error: '无法读取或解析该归档（文件不存在，或超过了 2GB 上限）' });
    return;
  }
  res.json(result);
});

/** 单个条目的结构详情（对应属性面板） */
gamesRouter.post('/archives/entry', (req, res) => {
  const { path: filePath, index, gameId } = (req.body ?? {}) as { path?: string; index?: number; gameId?: string };
  if (!filePath || index === undefined) {
    res.status(400).json({ error: '缺少 path 或 index' });
    return;
  }
  const detail = inspectEntry(String(filePath), Number(index), gameId);
  if (!detail) {
    res.status(404).json({ error: '无法取出该条目（可能数据为空或解压失败）' });
    return;
  }
  res.json(detail);
});

/** 条目内容预览：图片直接返回二进制；ANM 返回其首个精灵 */
gamesRouter.get('/archives/preview', (req, res) => {
  const q = req.query as Record<string, string>;
  if (!q.path || q.index === undefined) {
    res.status(400).json({ error: '缺少 path 或 index' });
    return;
  }
  const got = extractEntryData(String(q.path), Number(q.index), q.gameId);
  if (!got) {
    res.status(404).end();
    return;
  }

  const info = detectMagic(got.data);
  if (info.image) {
    res.type(info.mime).send(got.data);
    return;
  }

  const lowerName = got.name.toLowerCase();
  if (lowerName.endsWith('.anm') || !lowerName.includes('.')) {
    const anm = parseAnm(got.data);
    const first = anm?.sprites[0];
    if (anm && first) {
      const sp = extractSpriteImage(got.data, first);
      if (sp) {
        // 精灵可能是 PNG 也可能是 JPEG（红魔乡 / 妖妖梦），按实际魔数给出 MIME
        const sprInfo = detectMagic(sp.data);
        res.type(sprInfo.image ? sprInfo.mime : 'application/octet-stream').send(sp.data);
        return;
      }
    }
  }

  res.status(415).json({ error: '该条目不支持图形预览' });
});
