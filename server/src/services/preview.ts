/**
 * 预览图转码服务
 *
 * 素材库里的图不都是浏览器能渲染的格式：TH06NC 的 1225 张贴图全是
 * BC7 压缩的 DDS，浏览器直接显示会一片空白。这里把它们转成 PNG 并
 * 落盘缓存，转一次之后所有请求都走缓存。
 *
 * 解码用 Pillow（子进程）：C 实现，实测 8192x8192 的 BC7 解码约 0.3s，
 * 比手写 JS 解码器快两个数量级，而且格式覆盖面随 Pillow 升级自动变宽。
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../core/paths.ts';

/** 转码脚本的绝对路径（server/src/scripts/dds-preview.py） */
const SCRIPT = fileURLToPath(new URL('../scripts/dds-preview.py', import.meta.url));
const CACHE_DIR = path.join(DATA_DIR, 'Cache', 'previews');
const MAX_SIDE = 1024;
/** 单次转码超时（最大的 64MP 图实测 <1s，60s 已经非常宽裕） */
const TIMEOUT_MS = 60_000;

/** 浏览器原生渲染不了、必须转码的扩展名 */
const NEEDS_TRANSCODE = new Set(['.dds', '.tga', '.tif', '.tiff', '.psd', '.exr']);

export function needsTranscode(file: string): boolean {
  return NEEDS_TRANSCODE.has(path.extname(file).toLowerCase());
}

/** 同一文件的并发请求只转一次 */
const inFlight = new Map<string, Promise<string | null>>();

function cachePathFor(file: string): string {
  const st = fs.statSync(file);
  const key = crypto
    .createHash('sha1')
    .update(`${path.resolve(file)}|${st.size}|${st.mtimeMs}|${MAX_SIDE}|v1`)
    .digest('hex');
  return path.join(CACHE_DIR, `${key}.png`);
}

/** 跑一次转码，返回输出文件路径；失败返回 null */
function transcode(src: string, dst: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('python3', [SCRIPT, src, dst, String(MAX_SIDE)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      console.error(`  [preview] 无法启动 python3: ${err.message}`);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(dst)) {
        resolve(dst);
      } else {
        console.error(`  [preview] 转码失败 (${path.basename(src)}): ${stderr.trim() || `exit ${code}`}`);
        // 清掉半成品，避免下次误判缓存有效
        try {
          fs.unlinkSync(dst);
        } catch {
          /* 不存在就算了 */
        }
        resolve(null);
      }
    });
  });
}

/**
 * 启动自检：转码依赖本机的 python3 + Pillow。
 * 缺失时 DDS/TGA 等格式无法预览（接口返回 415 并在日志说明），
 * PNG/JPG 等浏览器原生格式完全不受影响。
 */
export function checkTranscoder(): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn('python3', ['-c', 'import PIL; print(PIL.__version__)'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.on('error', () => resolve({ ok: false, detail: '找不到 python3' }));
    child.on('close', (code) =>
      resolve(
        code === 0
          ? { ok: true, detail: `Pillow ${out.trim()}` }
          : { ok: false, detail: 'python3 可用但未装 Pillow（pip3 install pillow）' },
      ),
    );
  });
}

/**
 * 把一个无法直接渲染的图转成 PNG，返回缓存文件路径。
 * 已有缓存（或已在转换中）时立即返回，不重复解码。
 */
export function ensureRasterPreview(file: string): Promise<string | null> {
  if (!needsTranscode(file) || !fs.existsSync(file)) return Promise.resolve(null);

  const dst = cachePathFor(file);
  if (fs.existsSync(dst)) return Promise.resolve(dst);

  const running = inFlight.get(dst);
  if (running) return running;

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const task = transcode(path.resolve(file), dst).finally(() => inFlight.delete(dst));
  inFlight.set(dst, task);
  return task;
}
