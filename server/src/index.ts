import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PROJECT_ROOT, ensureDir } from './core/paths.ts';
import { gamesRouter } from './routes/games.ts';
import { assetsRouter } from './routes/assets.ts';
import { analysisRouter } from './routes/analysis.ts';
import { studioRouter } from './routes/studio.ts';

const app = express();
const PORT = Number(process.env.PORT ?? 8787);

app.use(cors());
app.use(express.json({ limit: '32mb' }));

// ---------------------------------------------------------------- API

app.use('/api', gamesRouter);
app.use('/api', assetsRouter);
app.use('/api', analysisRouter);
app.use('/api', studioRouter);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'Touhou Resource Studio', version: '1.0.0', dataDir: DATA_DIR });
});

// ---------------------------------------------------------------- 资源文件服务

ensureDir(DATA_DIR);
app.use(
  '/files',
  express.static(DATA_DIR, {
    index: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

// ---------------------------------------------------------------- 前端（生产构建）

const webDist = path.join(PROJECT_ROOT, 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api|files).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

// ---------------------------------------------------------------- 错误处理

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[TRS] 请求处理失败:', err);
  res.status(500).json({ error: err.message ?? '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`\n  东方资源研究工作台 · 服务已启动`);
  console.log(`  API      http://127.0.0.1:${PORT}/api/health`);
  console.log(`  资源目录  ${DATA_DIR}`);
  if (fs.existsSync(webDist)) console.log(`  前端      http://127.0.0.1:${PORT}/\n`);
  else console.log(`  前端      http://127.0.0.1:5173/ (Vite 开发服务器)\n`);
});
