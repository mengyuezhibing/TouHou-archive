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
  /** 行槽位（0=对话框第一行，1=第二行）。仅指令式布局提供 */
  side?: number;
  /** 所属对白段（场景段）序号。仅指令式布局提供 */
  segment?: number;
  /** 所属交换（控制记录分隔的脚本单位）序号 */
  exchange?: number;
  /**
   * 所属对话箱序号：由行槽位配对而得（m0 开启新箱、紧随的 m1 归入同箱）。
   * 一个对话箱 = 一个发言轮次（同屏 1-2 行、同一说话人），比控制记录更可靠——
   * 多余的控制记录会造成箱边界错位。
   */
  box?: number;
}

/** 对白段：场景表中一组连续的场景槽位共享同一段对白（不同自机路线各有一份） */
export interface MsgSegment {
  offset: number;
  sceneSlots: number[];
  lineStart: number;
  lineEnd: number;
}

export interface MsgParseResult {
  layout: 'structured' | 'scanned';
  lines: MsgLine[];
  notes: string[];
  confidence: number;
  /** 指令式布局的对白段（场景段），供自机路线区分 */
  segments?: MsgSegment[];
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

/**
 * TH06 系「指令式」布局——原版红魔乡与 New Classic 的 msg 同构：
 *
 *   文件头 = 场景数 u32 + 场景偏移表[count]
 *   记录 = time u16 + opcode u8 + size u8 + body[size]
 *   body = rank u16 + param_mask u16 + params[size-4]
 *   opcode 3 = 文本：params 前 2 字节为**说话方**（0=左/自机侧，1=右/Boss 侧），
 *              其后为正文（原版为 Shift-JIS，New Classic 为文本 ID，NUL 补齐）
 *   time=0 且 opcode=0 且 size=0 → 4 字节填充记录
 *
 * 场景表里多个槽位可指向同一段对白；**不同自机路线（灵梦 / 魔理沙）各有
 * 独立的对白段**——按段区分说话人即可实现自机路线标注。
 */
export function parseMsgInstructions(
  buf: Buffer,
): { lines: MsgLine[]; segments: MsgSegment[] } | null {
  if (buf.length < 8) return null;
  const count = buf.readUInt32LE(0);
  if (count < 1 || count > 4096 || 4 + count * 4 > buf.length) return null;

  const slots: number[] = [];
  for (let i = 0; i < count; i++) slots.push(buf.readUInt32LE(4 + i * 4));
  const distinct = [...new Set(slots)].sort((a, b) => a - b);
  const tableEnd = 4 + count * 4;
  if (distinct[0] !== tableEnd) return null; // 场景表后必须紧跟第一段对白

  const lines: MsgLine[] = [];
  const segments: MsgSegment[] = [];

  for (let si = 0; si < distinct.length; si++) {
    const segStart = distinct[si];
    const segEnd = si + 1 < distinct.length ? distinct[si + 1] : buf.length;
    const lineStart = lines.length;
    let pos = segStart;
    let exchange = 0;
    let boxIdx = -1;

    while (pos + 4 <= buf.length && pos < segEnd) {
      const time = buf.readUInt16LE(pos);
      const opcode = buf[pos + 2];
      const size = buf[pos + 3];
      const body = pos + 4;

      if (opcode === 0 && size === 0) {
        pos += 4; // 填充记录
        continue;
      }
      if (size < 4) {
        pos += 4; // 只有前缀的短记录（如 opcode 6 的时间轴指令），无 body
        continue;
      }
      if (body + size > buf.length) return null;

      if (opcode === 4) {
        exchange += 1; // 控制记录 = 对话框边界（一个对话框 = 一个发言轮次）
      } else if (opcode === 3) {
        const side = buf.readUInt16LE(body + 2);
        const raw = buf.subarray(body + 4, body + size);
        const { text, encoding } = decodeAuto(raw);
        const clean = text.replace(/\0+$/g, '').trim();
        if (clean) {
          // 槽位配对：m0（或首行）开启新对话箱，m1 归入前一箱
          if (side !== 1 || boxIdx < 0) boxIdx += 1;
          lines.push({
            index: lines.length,
            time,
            text: clean,
            encoding,
            side,
            segment: si,
            exchange,
            box: boxIdx,
          });
        }
      }
      pos = body + size;
    }
    segments.push({
      offset: segStart,
      sceneSlots: slots.map((s, i) => (s === segStart ? i : -1)).filter((i) => i >= 0),
      lineStart,
      lineEnd: lines.length,
    });
  }

  // 合理性：正文应当是日文 / 文本 ID，而不是二进制噪声
  if (lines.length === 0) return null;
  const like = lines.filter((l) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(l.text) || /^ST_[A-Z0-9_]+$/.test(l.text)).length;
  if (like / lines.length < 0.5) return null;
  return { lines, segments };
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
  const instructions = parseMsgInstructions(buf);
  if (instructions) {
    return {
      layout: 'structured',
      lines: instructions.lines,
      segments: instructions.segments,
      notes: [
        `指令式布局解析成功，共 ${instructions.lines.length} 条文本记录（含说话方），对白段 ${instructions.segments.length} 个`,
      ],
      confidence: 0.85,
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
