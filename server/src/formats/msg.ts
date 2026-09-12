import { Buffer } from 'node:buffer';
import { decodeAuto } from './textcodec.ts';

/**
 * ZUN Engine 剧情文本文件（*.msg）解析器。
 *
 * 经典布局（红魔乡 ~ 风神录）为一串定长头部记录：
 *   u32 time    出现时间（帧）
 *   u16 length  文本字节数
 *   u16 zero
 *   u8  text[length]   Shift-JIS
 *
 * 后续作品字段更多，这里在结构解析失败时回退为"可打印文本段扫描"。
 */

export interface MsgLine {
  index: number;
  time: number;
  text: string;
  encoding: string;
}

export interface MsgParseResult {
  layout: 'structured' | 'scanned';
  lines: MsgLine[];
  notes: string[];
  confidence: number;
}

function tryStructured(buf: Buffer): MsgLine[] | null {
  const lines: MsgLine[] = [];
  let pos = 0;
  let guard = 0;

  while (pos + 8 <= buf.length && guard < 20000) {
    guard++;
    const time = buf.readUInt32LE(pos);
    const length = buf.readUInt16LE(pos + 4);
    const zero = buf.readUInt16LE(pos + 6);

    if (length === 0) {
      // 空记录：可能是结束标记或填充
      pos += 8;
      continue;
    }
    if (length > 4096 || pos + 8 + length > buf.length) return null;
    if (zero !== 0 && zero !== 0xffff) return null;

    const raw = buf.subarray(pos + 8, pos + 8 + length);
    const { text, encoding } = decodeAuto(raw);
    lines.push({ index: lines.length, time, text: text.replace(/\0+$/g, ''), encoding });
    pos += 8 + length;
  }

  // 必须基本走完文件且内容像对话
  if (lines.length === 0) return null;
  const tail = buf.length - pos;
  if (tail > 64) return null;
  const japanese = lines.filter((l) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(l.text)).length;
  if (japanese / lines.length < 0.3) return null;
  return lines;
}

function scanText(buf: Buffer): MsgLine[] {
  const lines: MsgLine[] = [];
  let start = -1;
  let pos = 0;

  const flush = (end: number) => {
    if (start < 0) return;
    const chunk = buf.subarray(start, end);
    if (chunk.length < 2) {
      start = -1;
      return;
    }
    const { text, encoding } = decodeAuto(chunk);
    const cleaned = text.replace(/[\u0000-\u001f]+/g, ' ').trim();
    if (cleaned.length >= 1) {
      lines.push({ index: lines.length, time: 0, text: cleaned, encoding });
    }
    start = -1;
  };

  while (pos < buf.length) {
    const b = buf[pos];
    const isTextByte = b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b !== 0x7f);
    if (isTextByte) {
      if (start < 0) start = pos;
    } else {
      flush(pos);
    }
    pos++;
  }
  flush(buf.length);
  return lines.filter((l) => /[\u3040-\u30ff\u4e00-\u9fffA-Za-z]{2,}/.test(l.text));
}

export function parseMsg(buf: Buffer): MsgParseResult {
  const structured = tryStructured(buf);
  if (structured) {
    return {
      layout: 'structured',
      lines: structured,
      notes: [`结构化解析成功，共 ${structured.length} 条文本记录`],
      confidence: 0.9,
    };
  }
  const scanned = scanText(buf);
  return {
    layout: 'scanned',
    lines: scanned,
    notes: ['未匹配经典记录结构，已回退为可打印文本段扫描'],
    confidence: scanned.length > 0 ? 0.4 : 0,
  };
}
