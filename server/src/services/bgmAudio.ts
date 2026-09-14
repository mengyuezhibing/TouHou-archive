/**
 * BGM 音频转码服务：TH06NC 的自定义 opus 容器 → 16-bit WAV（带磁盘缓存）。
 *
 * 首次请求某曲目时解码并缓存，之后直接命中缓存。解码用 opus-decoder
 * （WASM libopus），按引擎实际行为整帧喂入（每帧 488B → 480 采样 @48kHz）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { OpusDecoder } from 'opus-decoder';
import { readNcOpus } from '../formats/ncOpus.ts';

const decoder = new OpusDecoder({ sampleRate: 48000, channels: 2 });
const ready = decoder.ready;

/** 转码缓存路径：与源文件同目录、扩展名 .wav */
export function wavCachePathFor(source: string): string {
  return source.replace(/\.[^.]+$/, '') + '.wav';
}

/**
 * 是否已完成过转码（缓存有效）。
 * 用「预期时长」校验缓存：期望大小 = 44 + 包数 × 960 × 声道 × 2。
 * 这样换解码实现后旧缓存（如早期误解读出的短时长 WAV）会自动失效重建。
 */
export function hasCachedWav(source: string): boolean {
  const wav = wavCachePathFor(source);
  if (!fs.existsSync(wav)) return false;
  const parsed = readNcOpus(source);
  if (!parsed) return false;
  const expected = 44 + parsed.packetCount * 960 * parsed.channels * 2;
  const actual = fs.statSync(wav).size;
  return Math.abs(actual - expected) <= expected * 0.01;
}

/**
 * 把 TH06NC 的自定义 opus 容器转成 16-bit WAV。
 * 已有缓存时直接返回；成功返回 WAV 路径，失败返回 null（原因打到 stderr）。
 */
export async function ensureNcOpusWav(source: string): Promise<string | null> {
  const wav = wavCachePathFor(source);
  if (hasCachedWav(source)) return wav;

  const parsed = readNcOpus(source);
  if (!parsed) {
    console.error(`  [bgm] 容器解析失败: ${path.basename(source)}`);
    return null;
  }

  await ready;
  const pcm: number[] = [];
  let peak = 0;
  let errors = 0;
  try {
    for (const packet of parsed.packets) {
      const out = decoder.decodeFrame(new Uint8Array(packet));
      errors += out.errors?.length ?? 0;
      // 交织写入（decoder 输出为分声道数组）
      const chs = out.channelData;
      for (let i = 0; i < out.samplesDecoded; i++) {
        for (let c = 0; c < chs.length; c++) {
          const v = chs[c][i];
          pcm.push(v);
          if (Math.abs(v) > peak) peak = Math.abs(v);
        }
      }
    }
  } catch (err) {
    console.error(`  [bgm] 解码异常: ${path.basename(source)}: ${(err as Error).message}`);
    return null;
  }
  if (pcm.length === 0) {
    console.error(`  [bgm] 解码输出为空: ${path.basename(source)}`);
    return null;
  }
  if (errors > parsed.packets.length * 0.01) {
    console.error(`  [bgm] 解码错误过多（${errors}/${parsed.packets.length}），疑似切包错误，拒绝产出`);
    return null;
  }

  // opus 解码输出为归一化 float [-1,1]（实证峰值 0.31），转 16-bit PCM
  const int16 = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    int16.writeInt16LE(Math.round(v * 32767), i * 2);
  }

  const channels = parsed.channels;
  const samplesPerCh = pcm.length / channels;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + int16.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(parsed.sampleRate, 24);
  header.writeUInt32LE(parsed.sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(int16.length, 40);

  const tmp = wav + '.tmp';
  fs.writeFileSync(tmp, Buffer.concat([header, int16]));
  fs.renameSync(tmp, wav);
  console.log(
    `  [bgm] 已转码 ${path.basename(source)}: ${parsed.packetCount} 包 → ${(samplesPerCh / 48000).toFixed(1)}s（峰值 ${peak.toFixed(3)}）`,
  );
  return wav;
}
