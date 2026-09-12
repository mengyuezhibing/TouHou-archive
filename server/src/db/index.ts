import Database from 'better-sqlite3';
import { DB_PATH, ensureDir, DATA_DIR } from '../core/paths.ts';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts';

ensureDir(DATA_DIR);

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(SCHEMA_SQL);

// ---------------------------------------------------------------- 版本管理

(function checkSchemaVersion() {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  const existing = Number(row?.value ?? 0);

  if (existing !== 0 && existing !== SCHEMA_VERSION) {
    console.warn(
      `\n[TRS] 数据库结构版本不匹配（现有 v${existing} / 期望 v${SCHEMA_VERSION}）。\n` +
        `      表结构已按新版本创建，但旧数据可能不完整。\n` +
        `      建议删除 Data/trs.db 后重新执行解包（演示数据可用 npm run seed 重建）。\n`,
    );
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    String(SCHEMA_VERSION),
  );
})();

// ---------------------------------------------------------------- 基础工具

export function nowIso(): string {
  return new Date().toISOString();
}

export function uid(prefix = ''): string {
  const s = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  return prefix ? `${prefix}_${s}` : s;
}

export function tx<T>(fn: () => T): T {
  const run = db.transaction(fn);
  return run();
}

export function jsonParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------- 主键 ⇄ 业务编码

/** 由作品编码（TH06）取得物理主键 */
export function gameIdByCode(code: string): number | null {
  if (!code) return null;
  const row = db.prepare('SELECT id FROM game WHERE code = ?').get(code) as { id: number } | undefined;
  return row?.id ?? null;
}

export function gameCodeById(id: number): string | null {
  const row = db.prepare('SELECT code FROM game WHERE id = ?').get(id) as { code: string } | undefined;
  return row?.code ?? null;
}

/** 由资源编码（TH06_SPRITE_0001）取得物理主键 */
export function resourceIdByCode(code: string): number | null {
  if (!code) return null;
  const row = db.prepare('SELECT id FROM resource WHERE code = ?').get(code) as { id: number } | undefined;
  return row?.id ?? null;
}

export function resourceCodeById(id: number): string | null {
  const row = db.prepare('SELECT code FROM resource WHERE id = ?').get(id) as { code: string } | undefined;
  return row?.code ?? null;
}

// ---------------------------------------------------------------- 标签多对多

/** 取得或创建标签，返回 tag.id */
export function ensureTag(name: string, category = 'user'): number {
  const norm = name.trim();
  if (!norm) return 0;
  db.prepare('INSERT INTO tag (name, category) VALUES (?, ?) ON CONFLICT(name) DO NOTHING').run(norm, category);
  const row = db.prepare('SELECT id FROM tag WHERE name = ?').get(norm) as { id: number } | undefined;
  return row?.id ?? 0;
}

/** 覆盖设置某个资源的标签集合 */
export function setResourceTags(resourceId: number, tags: string[]): void {
  db.prepare('DELETE FROM resource_tag WHERE resource_id = ?').run(resourceId);
  const stmt = db.prepare('INSERT OR IGNORE INTO resource_tag (resource_id, tag_id) VALUES (?, ?)');
  for (const t of new Set(tags.map((x) => x.trim()).filter(Boolean))) {
    const tid = ensureTag(t);
    if (tid) stmt.run(resourceId, tid);
  }
}

export function addResourceTag(resourceId: number, tag: string): void {
  const tid = ensureTag(tag);
  if (tid) db.prepare('INSERT OR IGNORE INTO resource_tag (resource_id, tag_id) VALUES (?, ?)').run(resourceId, tid);
}

export function removeResourceTag(resourceId: number, tag: string): void {
  db.prepare(
    'DELETE FROM resource_tag WHERE resource_id = ? AND tag_id = (SELECT id FROM tag WHERE name = ?)',
  ).run(resourceId, tag);
}

/** 读取某个资源的标签名数组 */
export function tagsOfResource(resourceId: number): string[] {
  const rows = db
    .prepare(
      `SELECT t.name FROM resource_tag rt
       JOIN tag t ON t.id = rt.tag_id
       WHERE rt.resource_id = ? ORDER BY t.name`,
    )
    .all(resourceId) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/** SQL 片段：以子查询把标签聚合回资源行（供列表查询复用） */
export const TAGS_SUBQUERY = `(
  SELECT COALESCE(json_group_array(t.name), '[]')
  FROM resource_tag rt JOIN tag t ON t.id = rt.tag_id
  WHERE rt.resource_id = r.id
) AS tags`;
