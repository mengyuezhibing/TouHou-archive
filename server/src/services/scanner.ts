import fs from 'node:fs';
import path from 'node:path';
import { TITLES, findTitleByFileName, isSupported, type TitleMeta } from '../data/titles.ts';
import { isReadableDir } from '../core/paths.ts';

/**
 * 游戏扫描服务。
 * 扫描用户指定目录，识别东方各作品的 exe 与归档文件（对应设计文档 3.1 / 3.2）。
 */

export interface DetectedFile {
  name: string;
  path: string;
  size: number;
}

export interface DetectedGame {
  id: string;
  name: string;
  nameJp: string;
  version: string;
  engine: string;
  year: number;
  kind: string;
  path: string;
  exePath: string | null;
  exeFound: boolean;
  datFiles: DetectedFile[];
  otherFiles: DetectedFile[];
  supported: boolean;
  note: string;
}

const SKIP_DIRS = new Set(['__MACOSX', '.git', 'node_modules', 'System Volume Information', '$RECYCLE.BIN']);

function collectFiles(root: string, maxDepth = 3): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('._')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}

export function scanDirectory(root: string): { games: DetectedGame[]; scannedFiles: number; notes: string[] } {
  const notes: string[] = [];
  if (!isReadableDir(root)) {
    return { games: [], scannedFiles: 0, notes: [`目录不可读：${root}`] };
  }

  const files = collectFiles(root);
  notes.push(`共扫描 ${files.length} 个文件`);

  const buckets = new Map<string, { title: TitleMeta; base: string; exe: string | null; dats: DetectedFile[]; others: DetectedFile[] }>();

  /**
   * 第一遍：用 exe 确定「游戏根 → 作品」。
   *
   * Classic / New Classic 的归档叫 th06ST.dat，只能识别到 TH06，
   * 单看文件名无法区分版本；新版归档还额外放在 data/ 子目录。
   * 因此以 exe 为准确定作品，归档沿目录向上归并到有 exe 的那个根 ——
   * 这样 th06nc/data/*.dat 才会归到 TH06NC，而不是散成独立的 TH06。
   */
  const rootTitle = new Map<string, TitleMeta>();
  for (const full of files) {
    if (!path.basename(full).toLowerCase().endsWith('.exe')) continue;
    const t = findTitleByFileName(path.basename(full));
    if (t) rootTitle.set(path.dirname(full), t);
  }

  const resolveTitle = (full: string): { title: TitleMeta; gameRoot: string } | null => {
    let dir = path.dirname(full);
    for (;;) {
      const t = rootTitle.get(dir);
      if (t) return { title: t, gameRoot: dir };
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    const t = findTitleByFileName(path.basename(full));
    return t ? { title: t, gameRoot: path.dirname(full) } : null;
  };

  for (const full of files) {
    const name = path.basename(full);
    const lower = name.toLowerCase();
    const resolved = resolveTitle(full);
    if (!resolved) continue;
    const { title, gameRoot } = resolved;

    const key = `${title.id}@${gameRoot}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { title, base: gameRoot, exe: null, dats: [], others: [] };
      buckets.set(key, bucket);
    }

    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      /* ignore */
    }
    const item: DetectedFile = { name, path: full, size };

    if (lower.endsWith('.exe')) {
      bucket.exe = full;
    } else if (lower.endsWith('.dat')) {
      bucket.dats.push(item);
    } else {
      bucket.others.push(item);
    }
  }

  // 合并同一作品在同一目录下的多个 exe（th06.exe / th06e.exe 等）
  const games: DetectedGame[] = [];
  for (const bucket of buckets.values()) {
    const { title } = bucket;
    const datFiles = bucket.dats.sort((a, b) => {
      // 主归档优先
      const aMain = a.name.toLowerCase() === title.mainDat ? -1 : 0;
      const bMain = b.name.toLowerCase() === title.mainDat ? -1 : 0;
      if (aMain !== bMain) return aMain - bMain;
      return b.size - a.size;
    });

    if (datFiles.length === 0 && !bucket.exe) continue;

    games.push({
      id: title.id,
      name: title.name,
      nameJp: title.nameJp,
      version: title.id,
      engine: title.engine,
      year: title.year,
      kind: title.kind,
      path: bucket.base,
      exePath: bucket.exe,
      exeFound: !!bucket.exe,
      datFiles,
      otherFiles: bucket.others,
      supported: isSupported(title),
      note: title.note ?? '',
    });
  }

  games.sort((a, b) => a.year - b.year);
  if (games.length === 0) {
    notes.push('未识别到东方系列作品，请确认目录中包含 thXX.exe 或 thXX.dat 等文件');
  }
  return { games, scannedFiles: files.length, notes };
}

/** 获取内置作品清单（用于界面上的"支持列表"展示） */
export function listSupportedTitles() {
  return TITLES.filter((t) => isSupported(t)).map((t) => ({
    id: t.id,
    name: t.name,
    nameJp: t.nameJp,
    year: t.year,
    mainDat: t.mainDat,
    exe: t.exe,
    note: t.note ?? '',
  }));
}
