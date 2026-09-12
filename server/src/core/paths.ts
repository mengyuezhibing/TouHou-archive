import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录（server/src/core -> ../../../） */
export const PROJECT_ROOT = path.resolve(here, '../../..');

/** 运行时数据根目录：/Data */
export const DATA_DIR = path.join(PROJECT_ROOT, 'Data');

/** SQLite 数据库文件 */
export const DB_PATH = path.join(DATA_DIR, 'trs.db');

/**
 * 导出资源缓存目录（按文档第十七节结构）：
 * /Data/Game/TH06/{Assets,Sprites,Sheets,Bullets,Analysis,Audio,BGM}
 */
export const EXPORT_DIR = path.join(DATA_DIR, 'Game');

/** 演示数据集目录 */
export const FIXTURE_DIR = path.join(DATA_DIR, 'DemoGames');

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 单个作品的缓存目录：/Data/Export/TH06 */
export function gameCacheDir(gameId: string): string {
  return ensureDir(path.join(EXPORT_DIR, gameId));
}

/** 资源分类子目录：/Data/Export/TH06/Assets 等 */
export function gameSubDir(gameId: string, sub: string): string {
  return ensureDir(path.join(gameCacheDir(gameId), sub));
}

export function isReadableDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180);
}
