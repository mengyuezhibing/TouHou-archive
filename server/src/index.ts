import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PROJECT_ROOT, ensureDir } from './core/paths.ts';
import { checkTranscoder } from './services/preview.ts';
import { gamesRouter } from './routes/games.ts';
import { assetsRouter } from './routes/assets.ts';
import { analysisRouter } from './routes/analysis.ts';
import { studioRouter } from './routes/studio.ts';

const app = express();
const PORT = Number(process.env.PORT ?? 8787);
/**
 * 监听地址：默认仅回环，符合「解包与解析全部在本机完成」的定位。
 * 需要从局域网 / 移动端访问时，用 HOST=0.0.0.0 启动（自行承担暴露风险）。
 */
const HOST = process.env.HOST ?? '127.0.0.1';

/**
 * CORS 策略：本工具为纯本地应用，只接受本地来源。
 * 开发模式前端在 5173（经 Vite 代理转发，属同源），生产模式由本服务直接托管前端。
 * 收紧的意义：避免任意网页在后台请求 127.0.0.1 上的本服务，读取本地素材或触发磁盘扫描。
 */
const LOCAL_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);

/** 跨源请求被拒：属预期内的安全拦截，不应记为服务端故障 */
class CorsRejectedError extends Error {
  readonly rejectedOrigin: string;
  constructor(origin: string) {
    super(`已拒绝来自 ${origin} 的跨源请求（本工具仅限本机使用）`);
    this.name = 'CorsRejectedError';
    this.rejectedOrigin = origin;
  }
}

app.use(
  cors({
    origin(origin, cb) {
      // 无 Origin：同源请求、curl、本地脚本 —— 放行
      if (!origin || LOCAL_ORIGINS.has(origin)) {
        cb(null, true);
        return;
      }
      cb(new CorsRejectedError(origin));
    },
  }),
);
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
// 数据库文件不属于素材，不通过静态服务对外提供
app.use('/files', (req, res, next) => {
  if (/\.(db|db-wal|db-shm)$/i.test(req.path)) {
    res.status(403).json({ error: '数据库文件不对外提供' });
    return;
  }
  next();
});
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
  if (err instanceof CorsRejectedError) {
    // 安全拦截：记一行提示即可，不当作故障
    console.warn(`[TRS] 已拦截跨源请求：${err.rejectedOrigin}`);
    res.status(403).json({ error: err.message });
    return;
  }
  console.error('[TRS] 请求处理失败:', err);
  res.status(500).json({ error: err.message ?? '服务器内部错误' });
});

app.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  console.log(`\n  东方资源研究工作台 · 服务已启动`);
  console.log(`  API      http://${shown}:${PORT}/api/health`);
  console.log(`  资源目录  ${DATA_DIR}`);
  if (HOST === '0.0.0.0') console.log(`  监听      0.0.0.0 —— 局域网内可访问，请确认网络环境可信`);
  if (fs.existsSync(webDist)) console.log(`  前端      http://${shown}:${PORT}/\n`);
  else console.log(`  前端      http://127.0.0.1:5173/ (Vite 开发服务器)\n`);

  // DDS/TGA 等格式的预览依赖本机 python3 + Pillow，缺失时给出明确提示
  void checkTranscoder().then(({ ok, detail }) => {
    if (ok) console.log(`  预览转码  就绪（${detail}）`);
    else
      console.warn(
        `  预览转码  不可用（${detail}）—— DDS 等格式将无法预览，PNG/JPG 不受影响`,
      );
  });
});
