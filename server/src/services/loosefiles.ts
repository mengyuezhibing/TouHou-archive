import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { db, nowIso, gameIdByCode, setResourceTags } from '../db/index.ts';

/**
 * 散落资源索引（loose files）。
 *
 * 游戏目录中存在大量**不经过 DAT 归档**的独立文件——最典型的是 BGM 目录下
 * 逐曲的 .wav（红魔乡的 17 首曲子就是如此，共 600MB+），以及部分版本的
 * 独立 se / 语音文件。它们同样属于研究素材，必须登记为 Resource 并进入音乐库。
 *
 * 与 DAT 解包的区别：不复制文件（原地引用），只建立索引与元数据。
 */

const AUDIO_EXT = new Set(['.wav', '.ogg', '.mp3', '.mid', '.m4a']);

export interface LooseTrackMeta {
  codec: string;
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  durationSeconds?: number;
}

/** 解析 WAV 头，取出采样率 / 声道 / 时长 */
export function parseWavHeader(buf: Buffer): LooseTrackMeta | null {
  if (buf.length < 44) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;

  let p = 12;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;

  while (p + 8 <= buf.length) {
    const id = buf.toString('latin1', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ' && p + 24 <= buf.length) {
      channels = buf.readUInt16LE(p + 10);
      sampleRate = buf.readUInt32LE(p + 12);
      bits = buf.readUInt16LE(p + 22);
    } else if (id === 'data') {
      const bytesPerSecond = sampleRate * channels * (bits / 8);
      return {
        codec: 'wav',
        channels,
        sampleRate,
        bitsPerSample: bits,
        durationSeconds: bytesPerSecond > 0 ? Number((size / bytesPerSecond).toFixed(2)) : undefined,
      };
    }
    p += 8 + size + (size % 2);
  }
  return { codec: 'wav', channels, sampleRate, bitsPerSample: bits };
}

export function parseOggHeader(buf: Buffer): LooseTrackMeta | null {
  if (buf.length < 4 || buf.toString('latin1', 0, 4) !== 'OggS') return null;
  // 采样率位于 vorbis 识别头：OggS(27) + 1 + "vorbis" + version(4) + channels(1) + rate(4)
  const idx = buf.indexOf(Buffer.from('vorbis', 'latin1'), 0);
  if (idx > 0 && idx + 16 <= buf.length) {
    return { codec: 'ogg', channels: buf[idx + 11], sampleRate: buf.readUInt32LE(idx + 12) };
  }
  return { codec: 'ogg' };
}

export function probeAudio(filePath: string): LooseTrackMeta {
  const ext = path.extname(filePath).toLowerCase();
  try {
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(Math.min(64 * 1024, fs.fstatSync(fd).size));
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    if (ext === '.wav') return parseWavHeader(head) ?? { codec: 'wav' };
    if (ext === '.ogg') return parseOggHeader(head) ?? { codec: 'ogg' };
    return { codec: ext.replace('.', '') || 'unknown' };
  } catch {
    return { codec: ext.replace('.', '') || 'unknown' };
  }
}

/** 从文件名推断曲名（去掉编号前缀与扩展名） */
function titleFromFileName(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/^th\d{2}[_-]?/i, '')
    .replace(/^\d+[-_ ]*/, '')
    .trim() || name;
}

function ext1(name: string): string {
  return name.toLowerCase().split('.').pop() ?? '';
}

/** 类型下标（与 crypt 表的 M T A J E W - * 顺序一致）*/
function resourceTypeOf(ext: string): { resourceType: string; category: string; kind: string } {
  if (ext === 'wav' || ext === 'ogg' || ext === 'mp3' || ext === 'mid') {
    return { resourceType: 'MUSIC', category: 'audio', kind: 'audio' };
  }
  if (ext === 'jpg' || ext === 'png' || ext === 'bmp') {
    return { resourceType: 'IMAGE', category: 'image', kind: 'image' };
  }
  if (ext === 'txt' || ext === 'ini' || ext === 'cfg') {
    return { resourceType: 'TEXT', category: 'text', kind: 'text' };
  }
  return { resourceType: 'BINARY', category: 'binary', kind: 'binary' };
}

export interface LooseIndexResult {
  scanned: number;
  indexed: number;
  tracks: number;
  skipped: number;
  warnings: string[];
}

/** 分配一个未被占用的资源编码 */
function nextCode(prefix: string, used: Set<string>, category: string): string {
  const key = `${prefix}_${category.toUpperCase()}_`;
  let n = 1;
  let code = `${key}${String(n).padStart(4, '0')}`;
  while (used.has(code)) {
    n++;
    code = `${key}${String(n).padStart(4, '0')}`;
  }
  used.add(code);
  return code;
}

/**
 * 扫描游戏目录下的独立文件并登记为资源。
 * 不复制文件本体，`resource.path` 直接指向原位置（原地引用）。
 */
export function indexLooseFiles(
  gameCode: string,
  dir: string,
  options: { includeImages?: boolean; maxFiles?: number; onProgress?: (cur: number, total: number, msg: string) => void } = {},
): LooseIndexResult {
  const warnings: string[] = [];
  const result: LooseIndexResult = { scanned: 0, indexed: 0, tracks: 0, skipped: 0, warnings };

  const gid = gameIdByCode(gameCode);
  if (!gid) {
    warnings.push(`作品 ${gameCode} 未登记`);
    return result;
  }
  if (!fs.existsSync(dir)) {
    warnings.push(`目录不存在：${dir}`);
    return result;
  }

  // 递归收集（深度 2，覆盖 BGM/ 这类子目录）
  const files: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile()) files.push(full);
    }
  };
  walk(dir, 0);
  result.scanned = files.length;

  const maxFiles = options.maxFiles ?? 4000;
  const used = new Set((db.prepare('SELECT code FROM resource WHERE game_id = ?').all(gid) as Array<{ code: string }>).map((r) => r.code));
  const existingPaths = new Set(
    (db.prepare('SELECT path FROM resource WHERE game_id = ? AND path IS NOT NULL').all(gid) as Array<{ path: string }>).map((r) => r.path),
  );

  const insertResource = db.prepare(`
    INSERT INTO resource (code, game_id, archive_id, filename, display_name, resource_type, kind, category, role,
                          ext, path, size, hash, entry_offset, meta, created_time)
    VALUES (@code, @gameId, NULL, @filename, @displayName, @resourceType, @kind, @category, @role,
            @ext, @path, @size, '', 0, @meta, @now)
  `);
  const insertMusic = db.prepare(`
    INSERT INTO music (game_id, index_num, title, filename, codec, size, path, boss, stage, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
  `);

  // 音乐序号接着已有记录排
  let musicIndex = ((db.prepare('SELECT COUNT(*) AS c FROM music WHERE game_id = ?').get(gid) as any).c as number) ?? 0;
  let processed = 0;

  for (const full of files) {
    if (result.indexed >= maxFiles) break;
    const base = path.basename(full);
    const ext = ext1(base);
    const isAudio = AUDIO_EXT.has(`.${ext}`);
    if (!isAudio && !(options.includeImages && ['png', 'jpg', 'jpeg'].includes(ext))) continue;
    if (existingPaths.has(full)) {
      result.skipped++;
      continue;
    }

    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      continue;
    }

    const info = resourceTypeOf(ext);
    const meta: Record<string, unknown> = { loose: true, dir: path.dirname(full) };

    // 音频：解析采样率与时长，并同步进入音乐库
    if (isAudio) {
      const track = probeAudio(full);
      meta.audio = track;
      const title = titleFromFileName(base);
      insertMusic.run(gid, musicIndex++, title, base, track.codec, size, full, JSON.stringify({ loose: true, ...track }));
      result.tracks++;
    }

    const code = nextCode(gameCode, used, info.category);
    insertResource.run({
      code,
      gameId: gid,
      filename: base,
      displayName: isAudio ? titleFromFileName(base) : base,
      resourceType: info.resourceType,
      kind: info.kind,
      category: info.category,
      role: isAudio ? 'ui' : 'unknown',
      ext: `.${ext}`,
      path: full,
      size,
      meta: JSON.stringify(meta),
      now: nowIso(),
    });

    const row = db.prepare('SELECT id FROM resource WHERE code = ?').get(code) as { id: number } | undefined;
    const rid = row?.id ?? 0;
    if (rid) {
      setResourceTags(rid, isAudio ? ['音频', 'BGM', '独立文件', '可播放'] : ['独立文件']);
    }

    result.indexed++;
    processed++;
    if (processed % 20 === 0) options.onProgress?.(processed, files.length, base);
  }

  return result;
}
