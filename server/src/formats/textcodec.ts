import { Buffer } from 'node:buffer';

/**
 * 日文文本解码工具。
 * ZUN 引擎的 .msg 文本使用 Shift-JIS 编码；Node 的 ICU 通常内置该解码器，
 * 若运行环境不支持则回退到 latin1 并做基础映射。
 */

let shiftJisDecoder: InstanceType<typeof TextDecoder> | null = null;
let shiftJisAvailable = false;

try {
  shiftJisDecoder = new TextDecoder('shift_jis', { fatal: false });
  // 触发一次解码验证可用性
  shiftJisDecoder.decode(Buffer.from([0x82, 0xa0]));
  shiftJisAvailable = true;
} catch {
  shiftJisAvailable = false;
}

export function decodeShiftJis(buf: Buffer): string {
  if (shiftJisAvailable && shiftJisDecoder) {
    try {
      return shiftJisDecoder.decode(buf);
    } catch {
      /* fallthrough */
    }
  }
  return buf.toString('latin1');
}

export function decodeUtf8(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/**
 * 自动判断编码并解码。
 * 判定顺序：严格 UTF-8 → Shift-JIS → 宽松 UTF-8 兜底。
 * 真正的 Shift-JIS 日文几乎不可能是合法 UTF-8 序列，因此该顺序不会误判。
 */
export function decodeAuto(buf: Buffer): { text: string; encoding: string } {
  const hasHighBytes = buf.some((b) => b >= 0x80);
  if (!hasHighBytes) return { text: buf.toString('latin1'), encoding: 'ascii' };

  try {
    const strict = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    if (/[\u3040-\u30ff\u4e00-\u9fff\uff61-\uff9f]/.test(strict)) {
      return { text: strict, encoding: 'utf-8' };
    }
  } catch {
    /* 不是合法 UTF-8，继续尝试 Shift-JIS */
  }

  const sjis = decodeShiftJis(buf);
  if (/[\u3040-\u30ff\u4e00-\u9fff\uff61-\uff9f]/.test(sjis)) {
    return { text: sjis, encoding: 'shift_jis' };
  }

  const utf8 = decodeUtf8(buf);
  if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(utf8)) {
    return { text: utf8, encoding: 'utf-8' };
  }
  return { text: sjis, encoding: 'shift_jis' };
}

export function isShiftJisAvailable(): boolean {
  return shiftJisAvailable;
}
