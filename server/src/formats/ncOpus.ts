/**
 * TH06NC BGM 容器（".opus" 扩展名，引擎自定义封装）解析。
 *
 * 结构（逆向自 th06nc.exe 音频加载器 + 解码实证）：
 *   40 字节文件头：
 *     +0x00 u32 0x80000001   参数节魔数
 *     +0x04 u32 24           参数节长度
 *     +0x08     参数节（byte@9=声道 1/2，word@0x0a=帧步长 488）
 *     +0x0c u32 48000        采样率（引擎校验）
 *     +0x1c u32 120          预留
 *     +0x20 u32 0x80000004   数据节魔数
 *     +0x24 u32 数据总长（= 文件长 - 40）
 *   数据段 = 488 字节定长帧序列，**每帧 = 8 字节开销 + 480 字节 opus 包体**：
 *     · 帧头 8 字节（`00 00 01 e0` + 4 字节变化位）不是 opus 数据
 *     · 包体是标准 opus 包（TOC 0xfc = CELT 全频带 20ms 立体声）
 *     · 每包解出 960 采样 @48kHz（20ms），全曲 = 帧数 × 20ms
 *   实证：80 包 0 错误、960 采样/包、峰值 0.31（归一化）；.pos 循环点
 *   （单位：采样）全部落在总时长之内，交叉验证成立。
 */
import fs from 'node:fs';

/** 每帧开销字节数（帧头 8 字节后才是 opus 包体） */
const FRAME_OVERHEAD = 8;

export interface NcOpusInfo {
  sampleRate: number;
  channels: number;
  frameSize: number;
  packetBytes: number;
  packetCount: number;
  /** opus 包体（已剥掉每帧的 8 字节开销） */
  packets: Buffer[];
}

export function parseNcOpus(buf: Buffer): NcOpusInfo | null {
  if (buf.length < 40) return null;
  if (buf.readUInt32LE(0) !== 0x80000001) return null;
  if (buf.readUInt32LE(0x20) !== 0x80000004) return null;
  const dataLen = buf.readUInt32LE(0x24);
  if (dataLen !== buf.length - 40) return null;
  const sampleRate = buf.readUInt32LE(0x0c);
  if (sampleRate !== 48000) return null;
  const channels = buf[9]; // 引擎校验 ∈ {1,2}
  if (channels !== 1 && channels !== 2) return null;
  const frameSize = buf.readUInt16LE(0x0a); // 488
  if (frameSize < 64) return null;
  const packetBytes = frameSize - FRAME_OVERHEAD; // 480
  const data = buf.subarray(40);
  const packetCount = Math.floor(data.length / frameSize);
  if (packetCount < 1) return null;

  const packets: Buffer[] = [];
  for (let i = 0; i < packetCount; i++) {
    const start = i * frameSize + FRAME_OVERHEAD;
    packets.push(Buffer.from(data.subarray(start, start + packetBytes)));
  }
  return { sampleRate, channels, frameSize, packetBytes, packetCount, packets };
}

/** 从磁盘读入并解析（辅助函数） */
export function readNcOpus(file: string): NcOpusInfo | null {
  return parseNcOpus(fs.readFileSync(file));
}
