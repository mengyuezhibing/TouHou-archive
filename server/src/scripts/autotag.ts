/**
 * 用 WD14 Tagger 给素材自动打标签。
 *
 * 只对达到尺寸阈值的素材打标 —— WD14 学的是同人插画，游戏内 30×32 的精灵
 * 像素量不足以支撑判定，打出来的结果只会是噪声。
 *
 * 用法：
 *   npx tsx src/scripts/autotag.ts --probe          # 试跑，只看几张的识别结果，不写库
 *   npx tsx src/scripts/autotag.ts --game TH06      # 批量打标并写入资源标签
 *   npx tsx src/scripts/autotag.ts --game TH06 --min 128
 */
import fs from 'node:fs';
import { db, setResourceTags } from '../db/index.ts';
import { decodePng, type RawImage } from '../core/png.ts';
import { decodeJpeg } from '../core/jpeg.ts';
import { tagImage, loadTagger, modelStatus, type TagResult } from '../services/tagger.ts';

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const opt = (name: string, fallback?: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const GAME = opt('--game');
const MIN_SIDE = Number(opt('--min', '128'));
const PROBE = has('--probe');
const THRESHOLD = Number(opt('--threshold', '0.35'));

interface Row {
  /** resource 表的物理主键（INTEGER），写标签与 meta 时用它 */
  id: number;
  code: string;
  display_name: string;
  path: string;
  width: number;
  height: number;
  category: string;
}

function decodeImage(file: string): RawImage | null {
  const buf = fs.readFileSync(file);
  return decodePng(buf) ?? decodeJpeg(buf);
}

/** 探针模式：挑几张不同尺寸的代表性素材，直观展示模型的能力边界 */
async function probe() {
  const samples: Row[] = [];
  const pick = (sql: string) => {
    const r = db.prepare(sql).get() as Row | undefined;
    if (r) samples.push(r);
  };
  pick(`SELECT r.id, r.code, r.display_name, r.path, i.width, i.height, r.category
        FROM resource r JOIN asset_image i ON i.resource_id=r.id
        WHERE r.category='portrait' AND i.width>=128 ORDER BY r.size DESC LIMIT 1`);
  pick(`SELECT r.id, r.code, r.display_name, r.path, i.width, i.height, r.category
        FROM resource r JOIN asset_image i ON i.resource_id=r.id
        WHERE r.category='background' AND i.width>=128 ORDER BY r.size DESC LIMIT 1`);
  pick(`SELECT r.id, r.code, r.display_name, r.path, i.width, i.height, r.category
        FROM resource r JOIN asset_image i ON i.resource_id=r.id
        WHERE r.category IN ('character','sprite') AND i.width<64 ORDER BY RANDOM() LIMIT 1`);
  pick(`SELECT r.id, r.code, r.display_name, r.path, i.width, i.height, r.category
        FROM resource r JOIN asset_image i ON i.resource_id=r.id
        WHERE r.category='ui' AND i.width>=128 ORDER BY r.size DESC LIMIT 1`);

  console.log('\n  WD14 探针：对 4 张不同类别的素材打标\n');
  for (const s of samples) {
    if (!s.path || !fs.existsSync(s.path)) continue;
    const img = decodeImage(s.path);
    if (!img) {
      console.log(`  ✗ 解码失败: ${s.display_name}`);
      continue;
    }
    const t0 = Date.now();
    const res = await tagImage(img, { threshold: THRESHOLD });
    const ms = Date.now() - t0;

    console.log(`  ── ${s.display_name}  [${s.category}]  ${img.width}×${img.height}  (${ms}ms)`);
    if (res.characters.length) {
      console.log('     角色: ' + res.characters.map((c) => `${c.name} ${c.score.toFixed(2)}`).join('  '));
    } else {
      console.log('     角色: （未识别出角色）');
    }
    if (res.general.length) {
      console.log('     特征: ' + res.general.slice(0, 8).map((c) => `${c.name} ${c.score.toFixed(2)}`).join('  '));
    }
    console.log('');
  }
}

/** 批量打标：结果写入资源标签，同时记录到 meta.aiTags */
async function runBatch() {
  const where = GAME ? 'AND g.code = ?' : '';
  const params = GAME ? [GAME] : [];
  const rows = db
    .prepare(
      `SELECT r.id, r.code, r.display_name, r.path, i.width, i.height, r.category
       FROM resource r
       JOIN asset_image i ON i.resource_id = r.id
       LEFT JOIN game g ON g.id = r.game_id
       WHERE i.width >= ${MIN_SIDE} AND i.height >= ${MIN_SIDE}
         AND r.path IS NOT NULL AND r.path != ''
         AND r.category != 'sheet'
         ${where}
       ORDER BY r.id`,
    )
    .all(...params) as Row[];

  console.log(`\n  待打标素材：${rows.length} 项（边长 ≥ ${MIN_SIDE}px，阈值 ${THRESHOLD}）\n`);
  if (rows.length === 0) return;

  const updateMeta = db.prepare('UPDATE resource SET meta = ? WHERE id = ?');
  let done = 0;
  let tagged = 0;
  let charHit = 0;
  const charCounter = new Map<string, number>();

  for (const r of rows) {
    if (!fs.existsSync(r.path)) continue;
    const img = decodeImage(r.path);
    if (!img) continue;

    let res: TagResult;
    try {
      res = await tagImage(img, { threshold: THRESHOLD });
    } catch (err) {
      console.log(`  ✗ ${r.display_name}: ${(err as Error).message}`);
      continue;
    }

    const tags = [...res.characters, ...res.general].map((t) => t.name);
    if (tags.length > 0) {
      setResourceTags(r.id, tags);
      tagged++;
    }
    if (res.characters.length > 0) {
      charHit++;
      for (const c of res.characters) charCounter.set(c.name, (charCounter.get(c.name) ?? 0) + 1);
    }

    // 把完整结果（含分数与分级标签）写进 meta，便于界面展示与人工复核
    const cur = db.prepare('SELECT meta FROM resource WHERE id = ?').get(r.id) as { meta: string } | undefined;
    const meta = JSON.parse(cur?.meta || '{}');
    meta.aiTags = {
      model: 'wd-v1-4-moat-tagger-v2',
      threshold: THRESHOLD,
      characters: res.characters,
      general: res.general,
      rating: res.rating,
      detectedAt: new Date().toISOString(),
    };
    updateMeta.run(JSON.stringify(meta), r.id);

    done++;
    if (done % 25 === 0) console.log(`  已处理 ${done}/${rows.length}`);
  }

  console.log(`\n  完成：处理 ${done} 项，命中标签 ${tagged} 项，识别出角色 ${charHit} 项`);
  if (charCounter.size > 0) {
    console.log('  角色命中统计:');
    for (const [name, n] of [...charCounter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`    ${name.padEnd(28)} ${n}`);
    }
  }
  console.log('');
}

async function main() {
  const st = modelStatus();
  console.log(`\n  模型: ${st.modelPath}`);
  console.log(`  标签表: ${st.tagCount} 条  ${st.ready ? '✓ 就绪' : '✗ 缺失'}`);
  if (!st.ready) {
    console.log('  请先下载 model.onnx 与 selected_tags.csv 到该目录\n');
    process.exit(1);
  }

  await loadTagger();
  if (PROBE) await probe();
  else if (GAME) await runBatch();
  else {
    console.log('\n  用法：--probe 试跑 / --game TH06 批量打标\n');
  }
}

main().catch((err) => {
  console.error('打标失败：', err);
  process.exit(1);
});
