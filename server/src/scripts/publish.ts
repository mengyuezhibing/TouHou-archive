/**
 * 发布导出：把本地解包成果导出为可公开托管的纯静态站点。
 *
 * 设计要点：导出复用 services/query.ts 的查询函数，而不是直接 SELECT *。
 * 这样产出的 JSON 形状与 API 响应逐字段一致，前端只需切换数据源即可，
 * 视图代码无需分叉。
 *
 * 产物结构：
 *   docs/
 *   ├── index.html        前端（由 vite 以静态模式构建后拷入）
 *   ├── assets/           JS / CSS
 *   ├── data/             数据库导出的 JSON
 *   ├── files/            资源文件（可直接下载）
 *   └── download/         按分类打包的 zip
 *
 * 用法：
 *   npx tsx src/scripts/publish.ts [--out docs] [--no-audio] [--no-zip] [--no-files]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA_DIR, EXPORT_DIR, PROJECT_ROOT, ensureDir } from '../core/paths.ts';
import {
  listGames,
  listArchives,
  listAssets,
  listCharacters,
  getCharacterAssets,
  listEnemies,
  listBosses,
  listSpells,
  listPatterns,
  getPattern,
  listAnimations,
  getAnimation,
  listBgm,
  listMsg,
  listTags,
  listTagsGrouped,
  listCategories,
  getDashboard,
} from '../services/query.ts';

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const OUT_DIR = path.resolve(PROJECT_ROOT, opt('--out', 'docs'));
const DATA_OUT = path.join(OUT_DIR, 'data');
const FILES_OUT = path.join(OUT_DIR, 'files');
const ZIP_OUT = path.join(OUT_DIR, 'download');

/**
 * 是否发布音频。
 * 默认包含（与「发布所有解包资源」一致）；音频的再分发风险高于图片，
 * 若只想公开图片与数据，用 --no-audio 排除。
 */
const INCLUDE_AUDIO = !has('--no-audio');
const MAKE_ZIP = !has('--no-zip');
const COPY_FILES = !has('--no-files');

// ---------------------------------------------------------------- 工具

function writeJson(relPath: string, data: unknown): number {
  const full = path.join(OUT_DIR, relPath);
  ensureDir(path.dirname(full));
  const text = JSON.stringify(data, null, 1);
  fs.writeFileSync(full, text, 'utf8');
  return Buffer.byteLength(text, 'utf8');
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function hasZipCommand(): boolean {
  try {
    execFileSync('zip', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function shouldPublish(rel: string): boolean {
  if (!INCLUDE_AUDIO && /\.(wav|mp3|ogg|mid|m4a|flac)$/i.test(rel)) return false;
  // 数据库与临时文件不进入发布产物
  if (/\.(db|db-wal|db-shm)$/i.test(rel)) return false;
  return true;
}

/**
 * 递归列出目录下所有文件（返回相对 DATA_DIR 的 POSIX 路径）。
 * 用遍历替代「查资源表再取 cache_path」的原因：Analysis 目录下的 ECL 反汇编结果、
 * Sheets 图集等属于流水线产物而非资源记录，只查表会漏掉它们。
 */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(path.relative(DATA_DIR, full).split(path.sep).join('/'));
    }
  }
  return out;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const started = Date.now();
  console.log('\n  东方资源研究工作台 · 发布导出\n');

  const dashboard = getDashboard() as any;
  const games = listGames() as any[];
  if (games.length === 0) {
    console.error('  数据库为空，先运行 npm run seed 或解包真实游戏文件。\n');
    process.exit(1);
  }

  // 重建输出目录
  if (fs.existsSync(DATA_OUT)) fs.rmSync(DATA_OUT, { recursive: true, force: true });
  if (COPY_FILES && fs.existsSync(FILES_OUT)) fs.rmSync(FILES_OUT, { recursive: true, force: true });
  if (MAKE_ZIP && fs.existsSync(ZIP_OUT)) fs.rmSync(ZIP_OUT, { recursive: true, force: true });
  ensureDir(DATA_OUT);
  ensureDir(OUT_DIR);

  // ------------------------------------------------------------ 1. 数据导出
  let dataBytes = 0;
  const gameCodes = games.map((g) => g.id);

  /**
   * listAssets 出于 API 保护把单次返回量限制在 500 条，
   * 导出全量必须自己翻页。排序固定为 name（即按 code 升序，唯一且稳定），
   * 否则翻页过程中顺序变化会导致记录重复或遗漏。
   */
  const collectAllAssets = () => {
    const PAGE = 500;
    const items: any[] = [];
    let total = 0;
    for (let offset = 0; ; offset += PAGE) {
      const page = listAssets({ limit: PAGE, offset, sort: 'name' }) as any;
      total = page.total;
      items.push(...page.items);
      if (page.items.length < PAGE || items.length >= total) break;
    }
    return { items, total };
  };

  const resources = collectAllAssets();
  dataBytes += writeJson('data/resources.json', { items: resources.items, total: resources.total });
  console.log(`  素材        ${resources.items.length} 项`);

  dataBytes += writeJson('data/games.json', { items: games });
  dataBytes += writeJson('data/archives.json', { items: listArchives() });
  dataBytes += writeJson('data/categories.json', { items: listCategories() });
  dataBytes += writeJson('data/tags.json', { items: listTags(undefined, 500) });
  dataBytes += writeJson('data/tags-grouped.json', { items: listTagsGrouped() });
  dataBytes += writeJson('data/dashboard.json', dashboard);

  // 角色：列表 + 每个角色的素材关联
  const characters = listCharacters() as any[];
  const characterDetails: Record<string, unknown> = {};
  for (const c of characters) {
    characterDetails[c.id] = getCharacterAssets(c.id);
  }
  dataBytes += writeJson('data/characters.json', { items: characters, details: characterDetails });
  console.log(`  角色        ${characters.length} 个`);

  dataBytes += writeJson('data/enemies.json', { items: listEnemies() });
  dataBytes += writeJson('data/bosses.json', { items: listBosses() });
  dataBytes += writeJson('data/spells.json', { items: listSpells() });
  console.log(`  符卡        ${(listSpells() as any[]).length} 张`);

  // 弹幕模式：列表 + 每个模式的动作时间轴
  const patterns = listPatterns() as any[];
  const patternDetails: Record<string, unknown> = {};
  for (const p of patterns) {
    patternDetails[p.id] = getPattern(p.id);
  }
  dataBytes += writeJson('data/patterns.json', { items: patterns, details: patternDetails });

  // 动画：列表 + 每个动画的帧序列
  const animations = listAnimations() as any[];
  const animationDetails: Record<string, unknown> = {};
  for (const a of animations) {
    animationDetails[String(a.id)] = getAnimation(a.id);
  }
  dataBytes += writeJson('data/animations.json', { items: animations, details: animationDetails });
  console.log(`  动画        ${animations.length} 段`);

  dataBytes += writeJson('data/bgm.json', { items: listBgm() });

  // 文本：按作品聚合，供全文检索
  const msgByGame: Record<string, unknown> = {};
  let msgTotal = 0;
  for (const code of gameCodes) {
    const res = listMsg(code, undefined, 100_000) as any;
    msgByGame[code] = res.items ?? res;
    msgTotal += (res.items ?? res).length;
  }
  dataBytes += writeJson('data/messages.json', { byGame: msgByGame, total: msgTotal });
  console.log(`  文本        ${msgTotal} 行`);

  dataBytes += writeJson('data/designs.json', { items: [] });
  dataBytes += writeJson('data/notes.json', { items: [] });

  // ------------------------------------------------------------ 2. 资源文件
  const publishedFiles: string[] = [];
  let fileBytes = 0;

  if (COPY_FILES) {
    let copied = 0;
    let skipped = 0;

    for (const rel of walkFiles(EXPORT_DIR)) {
      if (!shouldPublish(rel)) {
        skipped++;
        continue;
      }
      const src = path.join(DATA_DIR, rel);
      const dst = path.join(FILES_OUT, rel);
      ensureDir(path.dirname(dst));
      fs.copyFileSync(src, dst);
      publishedFiles.push(rel);
      fileBytes += fs.statSync(dst).size;
      copied++;
    }
    console.log(`  资源文件    ${copied} 个（${human(fileBytes)}）${skipped ? `，跳过 ${skipped}` : ''}`);
  }

  // 分析文件索引：指向 files/ 下已发布的 JSON，静态站点按需加载，
  // 避免把体积较大的反汇编结果再往 data/ 里复制一份。
  const analysisIndex: Record<string, string[]> = {};
  for (const rel of publishedFiles) {
    const m = rel.match(/\/Analysis\/(.+?)_([^_/]+)\.json$/);
    if (!m) continue;
    const assetId = m[1];
    if (!analysisIndex[assetId]) analysisIndex[assetId] = [];
    analysisIndex[assetId].push(rel);
  }
  dataBytes += writeJson('data/analysis-index.json', analysisIndex);

  // ------------------------------------------------------------ 3. 打包
  const zips: Array<{ name: string; size: number; label: string }> = [];

  if (MAKE_ZIP && COPY_FILES && publishedFiles.length > 0 && hasZipCommand()) {
    ensureDir(ZIP_OUT);

    /**
     * 用 `zip -@` 从标准输入读取文件清单，工作目录设为 files/。
     * 相比「先收集到临时目录再打包」，省去一次全量拷贝，
     * 也不会在站点目录里留下大量需要清理的中间文件。
     */
    const makeZip = (zipName: string, list: string[], label: string) => {
      if (list.length === 0) return;
      const zipPath = path.join(ZIP_OUT, zipName);
      try {
        execFileSync('zip', ['-q', '-9', zipPath, '-@'], { cwd: FILES_OUT, input: list.join('\n') });
        zips.push({ name: zipName, size: fs.statSync(zipPath).size, label: `${label} · ${list.length} 个文件` });
      } catch {
        /* 单个包失败不影响整体导出 */
      }
    };

    const groups: Array<{ name: string; label: string; match: (rel: string) => boolean }> = [
      { name: 'sprites', label: '精灵图（ANM 拆图）', match: (r) => r.includes('/Sprites/') },
      { name: 'sheets', label: '图集（Sprite Sheet + JSON）', match: (r) => r.includes('/Sheets/') },
      { name: 'images', label: '图片素材（立绘 / UI / 子弹）', match: (r) => r.includes('/Assets/') && !r.includes('/Assets/Audio/') },
      { name: 'audio', label: '音效', match: (r) => r.includes('/Assets/Audio/') },
      { name: 'analysis', label: '分析结果（ECL / 清单 / 图集元数据）', match: (r) => r.includes('/Analysis/') },
    ];

    for (const code of gameCodes) {
      const prefix = `Game/${code}/`;
      const gameFiles = publishedFiles.filter((r) => r.startsWith(prefix));
      if (gameFiles.length === 0) continue;

      for (const g of groups) {
        makeZip(`${code}-${g.name}.zip`, gameFiles.filter((r) => g.match(r)), g.label);
      }
      makeZip(`${code}-all.zip`, gameFiles, '完整资源包');
    }

    if (zips.length) {
      const total = zips.reduce((a, z) => a + z.size, 0);
      console.log(`  打包下载    ${zips.length} 个 zip（${human(total)}）`);
    }
  } else if (MAKE_ZIP && !hasZipCommand()) {
    console.log('  打包下载    已跳过（系统缺少 zip 命令）');
  }

  // ------------------------------------------------------------ 4. 站点清单
  const manifest = {
    schema: 'touhou-resource-studio.publish/1',
    generatedAt: new Date().toISOString(),
    games: games.map((g) => ({ code: g.id, name: g.name, year: g.year, engine: g.engine })),
    counts: {
      resources: resources.items.length,
      files: publishedFiles.length,
      characters: characters.length,
      animations: animations.length,
      patterns: patterns.length,
      spells: (listSpells() as any[]).length,
      messages: msgTotal,
    },
    options: { includeAudio: INCLUDE_AUDIO, files: COPY_FILES, zip: MAKE_ZIP },
    zips,
    filesBase: 'files',
    dataBase: 'data',
  };
  writeJson('data/manifest.json', manifest);

  // ------------------------------------------------------------ 5. 前端产物检查
  const webDist = path.join(PROJECT_ROOT, 'web', 'dist');
  let webCopied = 0;
  if (fs.existsSync(webDist)) {
    const copyDir = (src: string, dst: string) => {
      ensureDir(dst);
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory()) copyDir(s, d);
        else {
          fs.copyFileSync(s, d);
          webCopied++;
        }
      }
    };
    copyDir(webDist, OUT_DIR);
    console.log(`  前端产物    ${webCopied} 个文件（来自 web/dist）`);
  } else {
    console.log('  前端产物    未找到 web/dist —— 先运行 npm --prefix web run build');
  }

  // ------------------------------------------------------------ 汇总
  const totalBytes = dataBytes + fileBytes + zips.reduce((a, z) => a + z.size, 0);
  console.log(`\n  输出目录    ${OUT_DIR}`);
  console.log(`  数据        ${human(dataBytes)}`);
  if (COPY_FILES) console.log(`  资源文件    ${human(fileBytes)}`);
  if (zips.length) console.log(`  打包        ${human(zips.reduce((a, z) => a + z.size, 0))}`);
  console.log(`  合计        ${human(totalBytes)}`);
  console.log(`  耗时        ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}

main().catch((err) => {
  console.error('发布导出失败：', err);
  process.exit(1);
});
