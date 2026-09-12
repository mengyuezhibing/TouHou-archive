import { Buffer } from 'node:buffer';

export type MagicKind =
  | 'png'
  | 'jpeg'
  | 'bmp'
  | 'gif'
  | 'webp'
  | 'ogg'
  | 'wav'
  | 'midi'
  | 'mp3'
  | 'zip'
  | 'exe'
  | 'anm'
  | 'ecl'
  | 'msg'
  | 'text'
  | 'binary';

export interface MagicInfo {
  kind: MagicKind;
  /** 建议扩展名（含点） */
  ext: string;
  mime: string;
  label: string;
  /** 是否属于图片资源 */
  image: boolean;
  audio: boolean;
  text: boolean;
}

const TABLE: Array<{ magic: number[]; info: MagicInfo }> = [
  { magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], info: { kind: 'png', ext: '.png', mime: 'image/png', label: 'PNG 图像', image: true, audio: false, text: false } },
  { magic: [0xff, 0xd8, 0xff], info: { kind: 'jpeg', ext: '.jpg', mime: 'image/jpeg', label: 'JPEG 图像', image: true, audio: false, text: false } },
  { magic: [0x42, 0x4d], info: { kind: 'bmp', ext: '.bmp', mime: 'image/bmp', label: 'BMP 位图', image: true, audio: false, text: false } },
  { magic: [0x47, 0x49, 0x46, 0x38], info: { kind: 'gif', ext: '.gif', mime: 'image/gif', label: 'GIF 图像', image: true, audio: false, text: false } },
  { magic: [0x52, 0x49, 0x46, 0x46], info: { kind: 'wav', ext: '.wav', mime: 'audio/wav', label: 'WAV 音频', image: false, audio: true, text: false } },
  { magic: [0x4f, 0x67, 0x67, 0x53], info: { kind: 'ogg', ext: '.ogg', mime: 'audio/ogg', label: 'Ogg 音频', image: false, audio: true, text: false } },
  { magic: [0x4d, 0x54, 0x68, 0x64], info: { kind: 'midi', ext: '.mid', mime: 'audio/midi', label: 'MIDI 音乐', image: false, audio: true, text: false } },
  { magic: [0x49, 0x44, 0x33], info: { kind: 'mp3', ext: '.mp3', mime: 'audio/mpeg', label: 'MP3 音频', image: false, audio: true, text: false } },
  { magic: [0x50, 0x4b, 0x03, 0x04], info: { kind: 'zip', ext: '.zip', mime: 'application/zip', label: 'ZIP 容器', image: false, audio: false, text: false } },
  { magic: [0x4d, 0x5a], info: { kind: 'exe', ext: '.exe', mime: 'application/x-msdownload', label: 'Windows 可执行文件', image: false, audio: false, text: false } },
];

const WEBP_RIFF = Buffer.from('WEBP', 'latin1');
const RIFF_WAVE = Buffer.from('WAVE', 'latin1');

/** 基于魔数识别一段缓冲区的类型 */
export function detectMagic(buf: Buffer): MagicInfo {
  for (const { magic, info } of TABLE) {
    if (buf.length < magic.length) continue;
    let hit = true;
    for (let i = 0; i < magic.length; i++) {
      if (buf[i] !== magic[i]) {
        hit = false;
        break;
      }
    }
    if (!hit) continue;
    if (info.kind === 'wav') {
      // RIFF????WAVE
      if (buf.length >= 12 && buf.subarray(8, 12).equals(RIFF_WAVE)) return info;
      // RIFF????WEBP
      if (buf.length >= 12 && buf.subarray(8, 12).equals(WEBP_RIFF)) {
        return { kind: 'webp', ext: '.webp', mime: 'image/webp', label: 'WebP 图像', image: true, audio: false, text: false };
      }
      continue;
    }
    return info;
  }

  // 无魔数：尝试文本判定
  if (looksLikeText(buf)) {
    return { kind: 'text', ext: '.txt', mime: 'text/plain', label: '文本', image: false, audio: false, text: true };
  }

  return { kind: 'binary', ext: '.bin', mime: 'application/octet-stream', label: '二进制数据', image: false, audio: false, text: false };
}

/** 采样判断是否文本（可打印 ASCII 或合法 UTF-8 多字节） */
export function looksLikeText(buf: Buffer, sampleSize = 2048): boolean {
  const n = Math.min(buf.length, sampleSize);
  if (n === 0) return false;
  let printable = 0;
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0x09 || b === 0x0a || b === 0x0d) {
      printable++;
      continue;
    }
    if (b >= 0x20 && b <= 0x7e) {
      printable++;
      continue;
    }
    if (b >= 0x80) {
      // 可能是 UTF-8 / Shift-JIS 字节
      printable++;
      continue;
    }
    control++;
  }
  if (control / n > 0.05) return false;
  return printable / n > 0.9;
}

/** 按扩展名推断资源大类（用于素材分类） */
export function categoryFromName(name: string, info: MagicInfo): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.anm')) return 'anm';
  if (lower.endsWith('.ecl')) return 'ecl';
  if (lower.endsWith('.msg')) return 'msg';
  if (lower.endsWith('.std')) return 'std';
  if (lower.endsWith('.bgm') || lower.includes('thbgm')) return 'bgm';
  if (lower.endsWith('.se') || lower.includes('se_')) return 'se';
  if (info.image) return 'image';
  if (info.audio) return 'audio';
  if (info.text) return 'text';
  return 'binary';
}
