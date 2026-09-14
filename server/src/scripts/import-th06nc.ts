/**
 * 把 TH06NC 的 PKGL 归档导入研究工作台
 *
 * 做三件事：
 *   1. 清理旧的 raw-scan 误报（当初用魔数盲扫加密数据，12661 条全是假的）
 *   2. 用 formats/pkg.ts 正确解包，落盘到 Data/Game/TH06NC/<归档名>/
 *   3. 写入 resource / asset_image / tag 记录，供工作台各视图使用
 *
 * 用法：
 *   tsx src/scripts/import-th06nc.ts <游戏 data 目录> [--keep-old] [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { db, nowIso, setResourceTags } from '../db/index.ts';
import { EXPORT_DIR, ensureDir } from '../core/paths.ts';
import { PkgArchive } from '../formats/pkg.ts';
import { classifyEntry } from '../services/classify.ts';
import type { MagicInfo } from '../core/magic.ts';

const GAME_CODE = 'TH06NC';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const srcDir = args.find((a) => !a.startsWith('--'));
if (!srcDir) {
  console.error('  用法：tsx src/scripts/import-th06nc.ts <游戏 data 目录> [--dry]');
  process.exit(1);
}

// ---------------------------------------------------------------- 类型判定

/** 扩展名 → 资源类型。分类的细化交给 services/classify.ts */
function typeOf(name: string): { resourceType: string; kind: string; category: string; role: string } {
  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case '.dds':
      return { resourceType: 'IMAGE', kind: 'image', category: 'image', role: 'unknown' };
    case '.png':
    case '.jpg':
      return { resourceType: 'IMAGE', kind: 'image', category: 'image', role: 'unknown' };
    case '.anm':
      return { resourceType: 'ANIMATION', kind: 'anm', category: 'anm', role: 'unknown' };
    case '.wav':
      return { resourceType: 'AUDIO', kind: 'audio', category: 'audio', role: 'audio' };
    case '.ogg':
    case '.opus':
    case '.mp3':
      return { resourceType: 'MUSIC', kind: 'audio', category: 'audio', role: 'audio' };
    case '.txt':
    case '.json':
    case '.csv':
      return { resourceType: 'TEXT', kind: 'text', category: 'text', role: 'data' };
    case '.ecl':
    case '.std':
      return { resourceType: 'SCRIPT', kind: 'script', category: 'script', role: 'data' };
    default:
      return { resourceType: 'BINARY', kind: 'binary', category: 'binary', role: 'data' };
  }
}

/**
 * 从扩展名还原一个最小 MagicInfo。
 * MagicKind 里没有 dds 这一档，但 DDS 与 PNG 同属位图，按图片类参与分类即可。
 */
function magicFromExt(ext: string): MagicInfo {
  const e = (ext || '').toLowerCase();
  const base = { ext: e, mime: '', label: '' };
  if (['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp', '.dds'].includes(e)) {
    return { kind: 'png', ...base, image: true, audio: false, text: false };
  }
  if (['.wav', '.ogg', '.mid', '.mp3', '.m4a', '.opus'].includes(e)) {
    return { kind: 'wav', ...base, image: false, audio: true, text: false };
  }
  if (['.txt', '.msg', '.json', '.csv'].includes(e)) {
    return { kind: 'text', ...base, image: false, audio: false, text: true };
  }
  if (e === '.anm') {
    return { kind: 'anm', ...base, image: true, audio: false, text: false };
  }
  if (e === '.ecl' || e === '.std') {
    return { kind: 'ecl', ...base, image: false, audio: false, text: false };
  }
  return { kind: 'binary', ...base, image: false, audio: false, text: false };
}

/** 解析 DDS 头，取出尺寸与像素格式（失败返回零值，不影响导入） */
function ddsInfo(buf: Buffer): { width: number; height: number; format: string } {
  if (buf.length < 128 || buf.toString('latin1', 0, 4) !== 'DDS ') {
    return { width: 0, height: 0, format: '' };
  }
  const height = buf.readUInt32LE(12);
  const width = buf.readUInt32LE(16);
  const fourCC = buf.readUInt32LE(84);
  let format = '';
  if (fourCC === 0x30315844) format = 'DX10';
  else if (fourCC !== 0) format = buf.toString('latin1', 84, 88).replace(/\0/g, '');
  else format = `RGB${buf.readUInt32LE(88)}`;
  return { width, height, format };
}

/** 从文件名里抽出可检索的标签：语言、是否 4K、来源归档 */
const LANGUAGES = ['zh-TW', 'zh-CN', 'es-419', 'es-ES', 'pt-BR', 'en', 'de', 'fr', 'it', 'ja', 'ko', 'ru'];
function tagsOf(name: string, archiveStem: string): string[] {
  const tags = ['TH06NC', archiveStem];
  const base = name.replace(/\.[^.]+$/, '');
  if (/_4k(?:$|_)/i.test(base)) tags.push('4K');
  for (const lang of LANGUAGES) {
    if (new RegExp(`(?:^|_)${lang.replace('-', '-')}(?:$|_)`, 'i').test(base)) {
      tags.push(lang);
      break;
    }
  }
  return tags;
}

// ---------------------------------------------------------------- 主流程

const gid = (db.prepare('SELECT id FROM game WHERE code = ?').get(GAME_CODE) as any)?.id as number | undefined;
if (!gid) {
  console.error(`  ✗ 数据库里没有 ${GAME_CODE} 这一作，请先扫描游戏目录`);
  process.exit(1);
}

const outRoot = path.join(EXPORT_DIR, GAME_CODE);
const datFiles = fs
  .readdirSync(srcDir)
  .filter((f) => f.toLowerCase().endsWith('.dat'))
  .sort();

console.log(`  游戏      ${GAME_CODE} (id=${gid})`);
console.log(`  源目录    ${srcDir}`);
console.log(`  输出      ${outRoot}`);
console.log(`  归档      ${datFiles.length} 个`);
if (DRY) console.log('  （试运行，不写入）');

// ---- 1. 清理旧数据
if (!DRY) {
  db.transaction(() => {
    db.prepare(
      'DELETE FROM resource_tag WHERE resource_id IN (SELECT id FROM resource WHERE game_id = ?)',
    ).run(gid);
    db.prepare(
      'DELETE FROM asset_image WHERE resource_id IN (SELECT id FROM resource WHERE game_id = ?)',
    ).run(gid);
    const removed = db.prepare('DELETE FROM resource WHERE game_id = ?').run(gid).changes;
    // 注意：不动 music 表 —— BGM 是 data/bgm/*.opus 独立文件，不在 PKGL 归档里，
    // 那批记录指向的是真实音频，应当保留。
    console.log(`\n  清理旧数据：resource ${removed} 条（music 表保持不动）`);
  })();
}

const oldDir = path.join(outRoot);
if (!DRY && fs.existsSync(oldDir)) {
  // 只删我们自己生成的产物目录，不动 game 表里记录的原始游戏路径。
  // 某些环境对批量删除有保护，删不掉时不致命 —— 后续写入会直接覆盖同名文件。
  try {
    fs.rmSync(oldDir, { recursive: true, force: true });
    console.log(`  已清理旧产物目录 ${oldDir}`);
  } catch (err) {
    console.warn(`  ! 旧产物目录未能清空（${(err as Error).message.split('\n')[0]}）`);
    console.warn(`    将直接覆盖写入；如需彻底重来，请手动删除 ${oldDir}`);
  }
}

// ---- 2. 解包 + 入库
const stmts = {
  archive: db.prepare(
    `UPDATE archive SET layout = ?, entry_count = ?, size = ?, confidence = ?, notes = ?, parsed_time = ?
     WHERE game_id = ? AND filename = ?`,
  ),
  resource: db.prepare(
    `INSERT INTO resource
       (code, game_id, archive_id, filename, display_name, resource_type, kind, category, role,
        ext, path, size, hash, entry_offset, meta, created_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
  ),
  image: db.prepare(
    'INSERT INTO asset_image (resource_id, width, height, format, thumbnail, has_alpha, dominant_color, color_names) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?)',
  ),
};

const counters = new Map<string, number>();
function nextCode(type: string): string {
  const n = (counters.get(type) ?? 0) + 1;
  counters.set(type, n);
  return `${GAME_CODE}_${type}_${String(n).padStart(4, '0')}`;
}

const totals = { files: 0, bytes: 0, images: 0, tags: 0 };
const started = Date.now();

for (const dat of datFiles) {
  const archivePath = path.join(srcDir, dat);
  const stem = path.basename(dat, path.extname(dat));
  const archive = PkgArchive.open(archivePath);
  const targetDir = path.join(outRoot, stem);
  const fileSize = fs.statSync(archivePath).size;

  if (!DRY) {
    ensureDir(targetDir);
    stmts.archive.run(
      'PKGL',
      archive.entries.length,
      fileSize,
      1.0,
      `PKGL 归档：索引 ${archive.entries.length} 条，索引与数据均按 16 字节周期 XOR，压缩算法 zstd`,
      nowIso(),
      gid,
      dat,
    );
  }
  const archiveId = (db.prepare('SELECT id FROM archive WHERE game_id = ? AND filename = ?').get(gid, dat) as any)?.id;

  let ok = 0;
  for (const entry of archive.entries) {
    const rel = entry.name.replace(/\\/g, '/').replace(/^\/+/, '');
    if (rel.split('/').some((p) => p === '..')) continue;
    const data = archive.read(entry);
    const dest = path.join(targetDir, rel);
    const t = typeOf(entry.name);

    if (!DRY) {
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, data);

      const code = nextCode(t.resourceType);
      const info =
        t.kind === 'image' ? ddsInfo(data) : { width: 0, height: 0, format: '' };

      const cls = classifyEntry({
        entryName: entry.name,
        archiveName: dat,
        magic: magicFromExt(path.extname(entry.name)),
        width: info.width,
        height: info.height,
        fromAnm: false,
        // 走 TH06NC 的版本专属规则（字模图集、msgframe、buttom_ns 等新命名）
        gameCode: GAME_CODE,
      });

      const rid = Number(
        stmts.resource.run(
          code,
          gid,
          archiveId ?? null,
          entry.name,
          path.basename(entry.name),
          t.resourceType,
          t.kind,
          cls.category ?? t.category,
          cls.role ?? t.role,
          path.extname(entry.name).toLowerCase(),
          dest,
          data.length,
          entry.offset,
          JSON.stringify({
            archive: dat,
            seed: `0x${entry.seed.toString(16).padStart(8, '0')}`,
            compressed: (entry.flags & 1) !== 0,
            storedSize: entry.storedSize,
            originalSize: entry.originalSize,
            flags: entry.flags,
            unpacker: 'formats/pkg.ts',
          }),
          nowIso(),
        ).lastInsertRowid,
      );

      if (t.kind === 'image' && info.width > 0) {
        stmts.image.run(rid, info.width, info.height, info.format || 'DDS', 1, '[]');
        totals.images++;
      }

      const tags = tagsOf(entry.name, stem);
      setResourceTags(rid, tags);
      totals.tags += tags.length;
    }

    ok++;
    totals.files++;
    totals.bytes += data.length;
  }
  archive.close();
  console.log(`  ${dat.padEnd(14)} ${String(ok).padStart(5)} 条目 → ${path.relative(process.cwd(), targetDir)}`);
}

if (!DRY) {
  db.prepare('UPDATE game SET status = ?, extracted_time = ? WHERE id = ?').run('extracted', nowIso(), gid);
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n  完成：${totals.files} 个文件，${(totals.bytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
console.log(`        其中图片 ${totals.images} 张，标签 ${totals.tags} 个，用时 ${secs}s`);
if (DRY) console.log('        （试运行，未写入任何数据）');
