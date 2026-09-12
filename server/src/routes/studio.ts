import { Router } from 'express';
import { listDesigns, getDesign, saveDesign, deleteDesign, listNotes, saveNote, deleteNote } from '../services/query.ts';
import { simulateDanmaku, exportGodotScript, exportPatternJson, describePattern, DEFAULT_DANMAKU } from '../services/danmaku.ts';

export const studioRouter = Router();

// ---------------------------------------------------------------- 创作辅助工程

studioRouter.get('/designs', (req, res) => {
  res.json({ items: listDesigns((req.query as any).kind) });
});

studioRouter.get('/designs/:id', (req, res) => {
  const d = getDesign(req.params.id);
  if (!d) {
    res.status(404).json({ error: '工程不存在' });
    return;
  }
  res.json(d);
});

studioRouter.post('/designs', (req, res) => {
  const body = req.body ?? {};
  if (!body.kind || !body.name) {
    res.status(400).json({ error: '缺少 kind 或 name' });
    return;
  }
  res.json(saveDesign(body));
});

studioRouter.delete('/designs/:id', (req, res) => {
  deleteDesign(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- 备注

studioRouter.get('/notes', (req, res) => {
  const q = req.query as Record<string, string>;
  res.json({ items: listNotes(q.targetType, q.targetId) });
});

studioRouter.post('/notes', (req, res) => {
  const body = req.body ?? {};
  if (!body.title && !body.body) {
    res.status(400).json({ error: '缺少内容' });
    return;
  }
  res.json(saveNote(body));
});

studioRouter.delete('/notes/:id', (req, res) => {
  deleteNote(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- 弹幕编辑器

studioRouter.get('/danmaku/default', (_req, res) => {
  res.json(DEFAULT_DANMAKU);
});

/** 按参数实时模拟弹幕（编辑器预览） */
studioRouter.post('/danmaku/simulate', (req, res) => {
  const params = req.body ?? {};
  const result = simulateDanmaku(params);
  res.json({ ...result, described: describePattern(result.params) });
});

/** 导出弹幕为引擎资源 */
studioRouter.post('/danmaku/export', (req, res) => {
  const body = req.body ?? {};
  const name = String(body.name ?? 'unnamed_pattern');
  const format = String(body.format ?? 'json');
  const result = simulateDanmaku(body.params ?? {});

  if (format === 'godot') {
    res.type('text/plain').send(exportGodotScript(name, result));
    return;
  }
  res.json(exportPatternJson(name, result, { note: body.note ?? '' }));
});
