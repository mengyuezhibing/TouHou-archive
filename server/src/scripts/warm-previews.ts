/**
 * 预览图预热脚本
 *
 * 用法: npx tsx src/scripts/warm-previews.ts
 *
 * 把素材库里所有浏览器渲染不了的图（TH06NC 的 BC7 DDS 等）批量转成
 * PNG 缓存，跑完之后翻页浏览完全零延迟。按需缓存同样可用，这个脚本
 * 只是把"第一次看图的等待"提前到一次性后台完成。
 */
import { db } from '../db/index.ts';
import { ensureRasterPreview, needsTranscode } from '../services/preview.ts';

const rows = db
  .prepare(
    `SELECT path FROM resource
      WHERE path IS NOT NULL AND ext IN ('.dds','.tga','.tif','.tiff','.psd','.exr')`,
  )
  .all() as Array<{ path: string }>;

const files = [...new Set(rows.map((r) => r.path))].filter(needsTranscode);
if (files.length === 0) {
  console.log('没有需要预热的文件。');
  process.exit(0);
}

console.log(`待预热 ${files.length} 张，并发 6 …`);
const queue = [...files];
const CONCURRENCY = 6;
let done = 0;
let fail = 0;
const t0 = Date.now();

async function worker(): Promise<void> {
  while (queue.length) {
    const file = queue.shift()!;
    const ok = await ensureRasterPreview(file);
    done += 1;
    if (!ok) {
      fail += 1;
      console.error(`  ✗ ${file}`);
    }
    if (done % 50 === 0 || done === files.length) {
      const el = (Date.now() - t0) / 1000;
      const eta = (el / done) * (files.length - done);
      console.log(
        `  ${done}/${files.length}  ${el.toFixed(0)}s  剩余约 ${eta.toFixed(0)}s  失败 ${fail}`,
      );
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`完成：${done} 张，失败 ${fail}，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(fail > 0 ? 1 : 0);
