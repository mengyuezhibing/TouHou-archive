import { Buffer } from 'node:buffer';
import { decodeAuto } from './textcodec.ts';

/**
 * thbgm.dat（BGM 包）解析器。
 *
 * 布局：
 *   0x00 起为曲目元信息字符串表，按 "曲名\0文件名\0" 成对重复，以空串结束
 *   数据区为等长的音频块序列（多数作品为 WAV 变体，后期作品为 OGG）
 *
 * 由于等长块与真实音频起点可能存在对齐差异，这里优先使用**音频魔数扫描**定位每曲起点，
 * 扫描结果与曲目数不一致时回退到等分策略。
 */

export interface BgmTrack {
  index: number;
  title: string;
  fileName: string;
  offset: number;
  size: number;
  codec: 'wav' | 'ogg' | 'unknown';
}

export interface BgmParseResult {
  tracks: BgmTrack[];
  dataOffset: number;
  notes: string[];
  confidence: number;
}

function readNamePairs(buf: Buffer): { title: string; fileName: string }[] {
  const pairs: { title: string; fileName: string }[] = [];
  let pos = 0;
  const limit = Math.min(buf.length, 0x2000);
  let guard = 0;

  const readCStr = (): string | null => {
    const start = pos;
    while (pos < limit && buf[pos] !== 0) pos++;
    if (pos >= limit) return null;
    const raw = buf.subarray(start, pos);
    pos++; // 跳过 NUL
    if (raw.length === 0) return '';
    if (raw.length > 200) return null;
    return decodeAuto(raw).text;
  };

  while (pos < limit && guard < 500) {
    guard++;
    const title = readCStr();
    if (title === null) break;
    if (title === '') break;
    const fileName = readCStr();
    if (fileName === null || fileName === '') break;
    // 文件名通常带扩展名
    if (!/\.(wav|ogg|mp3|bin)$/i.test(fileName) && !/^[A-Za-z0-9_\-. ]+$/.test(fileName)) break;
    pairs.push({ title, fileName });
  }
  return pairs;
}

function findAudioStarts(buf: Buffer): { offset: number; codec: 'wav' | 'ogg' }[] {
  const hits: { offset: number; codec: 'wav' | 'ogg' }[] = [];
  const ogg = Buffer.from('OggS', 'latin1');
  const riff = Buffer.from('RIFF', 'latin1');

  let i = 0;
  while (i < buf.length - 4) {
    const foundOgg = buf.indexOf(ogg, i);
    const foundRiff = buf.indexOf(riff, i);
    let next = -1;
    let codec: 'wav' | 'ogg' = 'wav';

    if (foundOgg !== -1 && (foundRiff === -1 || foundOgg < foundRiff)) {
      next = foundOgg;
      codec = 'ogg';
    } else if (foundRiff !== -1) {
      next = foundRiff;
      codec = 'wav';
    }
    if (next === -1) break;

    // RIFF 需要确认是 WAVE
    if (codec === 'wav') {
      if (next + 12 <= buf.length && buf.toString('latin1', next + 8, next + 12) !== 'WAVE') {
        i = next + 4;
        continue;
      }
      // 结束标记 RIFF....WAVEfmt 之后紧跟 data，跳过非音频 RIFF
    }
    hits.push({ offset: next, codec });
    i = next + 4;
  }

  // 去重：间隔过近视为同一曲
  const out: { offset: number; codec: 'wav' | 'ogg' }[] = [];
  for (const h of hits) {
    if (out.length === 0 || h.offset - out[out.length - 1].offset > 0x1000) out.push(h);
  }
  return out;
}

export function isThbgm(buf: Buffer, fileName = ''): boolean {
  if (/thbgm|bgm/i.test(fileName) && buf.length > 0x1000) return true;
  if (buf.length < 0x1000) return false;
  const pairs = readNamePairs(buf);
  if (pairs.length < 3) return false;
  return findAudioStarts(buf).length >= 3;
}

export function parseThbgm(buf: Buffer): BgmParseResult {
  const notes: string[] = [];
  const pairs = readNamePairs(buf);
  notes.push(`元信息字符串表解析出 ${pairs.length} 组曲目名`);

  const starts = findAudioStarts(buf);
  notes.push(`音频魔数扫描命中 ${starts.length} 个音频块起点`);

  const tracks: BgmTrack[] = [];

  if (pairs.length > 0 && starts.length === pairs.length) {
    for (let i = 0; i < pairs.length; i++) {
      const offset = starts[i].offset;
      const next = i + 1 < starts.length ? starts[i + 1].offset : buf.length;
      tracks.push({
        index: i,
        title: pairs[i].title,
        fileName: pairs[i].fileName,
        offset,
        size: next - offset,
        codec: starts[i].codec,
      });
    }
    return { tracks, dataOffset: starts[0]?.offset ?? 0, notes, confidence: 0.95 };
  }

  if (pairs.length > 0 && starts.length > 0) {
    // 用首个音频起点作为数据区起点，等分
    const dataStart = starts[0].offset;
    const trackSize = Math.floor((buf.length - dataStart) / pairs.length);
    for (let i = 0; i < pairs.length; i++) {
      const offset = dataStart + i * trackSize;
      const slice = buf.subarray(offset, offset + 4);
      const codec = slice.toString('latin1') === 'OggS' ? 'ogg' : slice.toString('latin1') === 'RIFF' ? 'wav' : 'unknown';
      tracks.push({ index: i, title: pairs[i].title, fileName: pairs[i].fileName, offset, size: trackSize, codec });
    }
    notes.push('音频块数量与曲目数不一致，已按数据区等分切分');
    return { tracks, dataOffset: dataStart, notes, confidence: 0.6 };
  }

  if (starts.length > 0) {
    for (let i = 0; i < starts.length; i++) {
      const offset = starts[i].offset;
      const next = i + 1 < starts.length ? starts[i + 1].offset : buf.length;
      tracks.push({ index: i, title: `Track ${String(i + 1).padStart(2, '0')}`, fileName: `track${String(i + 1).padStart(2, '0')}`, offset, size: next - offset, codec: starts[i].codec });
    }
    notes.push('未解析出曲名元信息，已按音频魔数顺序编号');
    return { tracks, dataOffset: starts[0].offset, notes, confidence: 0.5 };
  }

  return { tracks: [], dataOffset: 0, notes: ['未在本文件中找到可识别的音频数据'], confidence: 0 };
}
