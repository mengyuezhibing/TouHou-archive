import { Buffer } from 'node:buffer';

/**
 * ZUN Engine 敌人脚本（*.ecl）解析器。
 *
 * 文件头（依据 pytouhou 的 ECL 格式文档与 thtk 实现）：
 *   0x00  uint32  sub_count      子程序数量
 *   0x04  uint32  main_offset    主时间线的偏移
 *   0x08  uint32  padding[0]     恒为 0
 *   0x0C  uint32  padding[1]     恒为 0
 *   0x10  uint32  subs_offsets[sub_count]
 *
 * 子程序是**指令序列**，每条指令：
 *   uint32 frame_num
 *   uint16 opcode
 *   uint16 size        （不小于 0x0c）
 *   uint16 rank_mask
 *   uint16 param_mask
 *   uint8  params[size - 0x0c]
 * 终止：frame_num = 0xffffffff 且 opcode = 0xffff
 *
 * 有了正确的指令边界，弹幕参数不再通过全文件滑动窗口猜测，
 * 而是在**每条指令的参数区内部**提取，误报率大幅下降。
 */

/** 内部使用的指令表示（保留原始参数字节用于分析） */
interface RawInstruction {
  index: number;
  frame: number;
  opcode: number;
  size: number;
  rankMask: number;
  paramMask: number;
  params: Buffer;
  offset: number;
}

/** 对外输出的指令表示（参数以十六进制字符串给出，便于界面展示与人工核对） */
export interface EclInstruction {
  index: number;
  frame: number;
  opcode: number;
  size: number;
  rankMask: number;
  paramMask: number;
  paramHex: string;
  paramSize: number;
  offset: number;
}

export interface BulletParamCandidate {
  byteOffset: number;
  opcode: number;
  count: number | null;
  speed: number | null;
  angle: number | null;
  confidence: number;
}

export interface EclSubroutine {
  index: number;
  offset: number;
  size: number;
  instructions: EclInstruction[];
  candidates: BulletParamCandidate[];
  /** 指令流是否正常走到终止标记 */
  terminated: boolean;
}

export interface BulletPatternInference {
  kind: 'ring' | 'fan' | 'spiral' | 'single' | 'dense' | 'unknown';
  label: string;
  evidence: string;
  sampleCount: number;
  avgSpeed: number;
  avgCount: number;
  angleSpan: number;
}

export interface EclParseResult {
  layout: string;
  subCount: number;
  mainOffset: number;
  totalInstructions: number;
  subroutines: EclSubroutine[];
  inference: BulletPatternInference[];
  opcodeHistogram: { opcode: number; count: number }[];
  speedHistogram: { value: number; count: number }[];
  angleHistogram: { value: number; count: number }[];
  countHistogram: { value: number; count: number }[];
  notes: string[];
  confidence: number;
}

const MAX_SUBS = 20000;
const MAX_INSTRUCTIONS = 20000;

interface EclLayoutProbe {
  layout: string;
  subCount: number;
  mainOffset: number;
  subOffsets: number[];
  dataStart: number;
  score: number;
}

/**
 * 头部探测：两个恒为 0 的 padding 字段是最强的校验信号，
 * 它能有效区分真实 ECL 与碰巧数值合理的随机数据。
 */
function probeLayout(buf: Buffer): EclLayoutProbe | null {
  if (buf.length < 32) return null;

  const subCount = buf.readUInt32LE(0);
  const mainOffset = buf.readUInt32LE(4);
  const pad0 = buf.readUInt32LE(8);
  const pad1 = buf.readUInt32LE(12);

  if (subCount < 1 || subCount > MAX_SUBS) return null;
  if (pad0 !== 0 || pad1 !== 0) return null;
  if (mainOffset < 16 || mainOffset >= buf.length) return null;

  const tableEnd = 16 + subCount * 4;
  if (tableEnd > buf.length) return null;

  const subOffsets: number[] = [];
  for (let i = 0; i < subCount; i++) subOffsets.push(buf.readUInt32LE(16 + i * 4));

  let valid = 0;
  let ascending = 0;
  for (let i = 0; i < subOffsets.length; i++) {
    const o = subOffsets[i];
    if (o >= tableEnd - 4 && o < buf.length) valid++;
    if (i > 0 && o >= subOffsets[i - 1]) ascending++;
  }
  if (valid !== subOffsets.length) return null;

  let score = 6;
  if (subCount > 1 && ascending / (subCount - 1) > 0.9) score += 2;
  if (Math.abs(subOffsets[0] - tableEnd) < 256) score += 2;

  return { layout: 'ecl-th06', subCount, mainOffset, subOffsets, dataStart: tableEnd, score };
}

/** 按指令边界解析一段指令流 */
export function parseInstructions(buf: Buffer, from: number, to: number): { instructions: RawInstruction[]; terminated: boolean } {
  const instructions: RawInstruction[] = [];
  let p = from;
  let terminated = false;

  while (p + 12 <= to && instructions.length < MAX_INSTRUCTIONS) {
    const frame = buf.readUInt32LE(p);
    const opcode = buf.readUInt16LE(p + 4);
    const size = buf.readUInt16LE(p + 6);
    const rankMask = buf.readUInt16LE(p + 8);
    const paramMask = buf.readUInt16LE(p + 10);

    if (frame === 0xffffffff && opcode === 0xffff) {
      terminated = true;
      break;
    }
    if (size < 12 || p + size > to) break;

    instructions.push({
      index: instructions.length,
      frame,
      opcode,
      size,
      rankMask,
      paramMask,
      params: Buffer.from(buf.subarray(p + 12, p + size)),
      offset: p,
    });
    p += size;
  }

  return { instructions, terminated };
}

function f32(buf: Buffer, off: number): number | null {
  if (off < 0 || off + 4 > buf.length) return null;
  const v = buf.readFloatLE(off);
  return Number.isFinite(v) ? v : null;
}

function u16(buf: Buffer, off: number): number | null {
  if (off < 0 || off + 2 > buf.length) return null;
  return buf.readUInt16LE(off);
}

/**
 * 从单条指令的参数区提取弹幕参数候选。
 * ZUN 的弹幕指令通常把「弹数(u16) / 速度(f32) / 角度(f32)」放在参数区前部。
 */
function candidatesFromInstruction(ins: RawInstruction): BulletParamCandidate | null {
  const p = ins.params;
  if (p.length < 10) return null;

  // 在参数区内尝试有限几个常见起始偏移，而不是任意字节位置
  for (const start of [0, 2, 4]) {
    const count = u16(p, start);
    const speed = f32(p, start + 2);
    const angle = f32(p, start + 6);
    if (count === null || speed === null || angle === null) continue;
    if (count < 1 || count > 512) continue;
    if (speed < 0.05 || speed > 40) continue;
    if (angle < -720 || angle > 720) continue;

    let confidence = 0.55;
    if (count >= 2 && count <= 256) confidence += 0.15;
    if (speed >= 0.2 && speed <= 15) confidence += 0.15;
    if (Math.abs(angle) <= 361) confidence += 0.15;

    return {
      byteOffset: ins.offset + 12 + start,
      opcode: ins.opcode,
      count,
      speed: Math.round(speed * 1000) / 1000,
      angle: Math.round(angle * 100) / 100,
      confidence: Math.min(1, confidence),
    };
  }
  return null;
}

function histogram(values: number[], bucketize: (v: number) => number, minCount = 2, limit = 20) {
  const map = new Map<number, number>();
  for (const v of values) {
    const k = bucketize(v);
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map.entries()]
    .filter(([, c]) => c >= minCount)
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function inferPatterns(candidates: BulletParamCandidate[]): BulletPatternInference[] {
  if (candidates.length === 0) return [];
  const out: BulletPatternInference[] = [];

  const speeds = candidates.map((c) => c.speed).filter((v): v is number => v !== null);
  const counts = candidates.map((c) => c.count).filter((v): v is number => v !== null);
  const degrees = candidates.map((c) => ((c.angle as number) * 180) / Math.PI).filter((v) => Number.isFinite(v));

  const avgSpeed = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;
  const avgCount = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
  const span = degrees.length ? Math.max(...degrees) - Math.min(...degrees) : 0;

  if (avgCount >= 12 && span > 180) {
    out.push({
      kind: 'ring',
      label: '环形弹幕（全方位）',
      evidence: `平均弹数 ${avgCount.toFixed(1)}，角度跨度 ${span.toFixed(0)}°，符合全方位环射特征`,
      sampleCount: candidates.length,
      avgSpeed: Number(avgSpeed.toFixed(2)),
      avgCount: Number(avgCount.toFixed(1)),
      angleSpan: Number(span.toFixed(1)),
    });
  }
  if (avgCount >= 3 && avgCount < 12 && span <= 120) {
    out.push({
      kind: 'fan',
      label: '扇形散射',
      evidence: `平均弹数 ${avgCount.toFixed(1)}，角度跨度 ${span.toFixed(0)}°，符合扇形定向散射特征`,
      sampleCount: candidates.length,
      avgSpeed: Number(avgSpeed.toFixed(2)),
      avgCount: Number(avgCount.toFixed(1)),
      angleSpan: Number(span.toFixed(1)),
    });
  }
  if (span > 300 && avgCount < 12 && candidates.length >= 3) {
    out.push({
      kind: 'spiral',
      label: '旋转弹（螺旋）',
      evidence: '角度值全域分布且弹数较低，疑似逐帧递增角度的螺旋发射',
      sampleCount: candidates.length,
      avgSpeed: Number(avgSpeed.toFixed(2)),
      avgCount: Number(avgCount.toFixed(1)),
      angleSpan: Number(span.toFixed(1)),
    });
  }
  if (counts.length > 0 && counts.filter((c) => c === 1).length / counts.length > 0.5) {
    out.push({
      kind: 'single',
      label: '单发/米弹',
      evidence: '超过半数的候选弹数为 1，符合单发精确射击特征',
      sampleCount: counts.length,
      avgSpeed: Number(avgSpeed.toFixed(2)),
      avgCount: 1,
      angleSpan: Number(span.toFixed(1)),
    });
  }
  if (counts.length > 0 && counts.filter((c) => c >= 64).length / counts.length > 0.25) {
    out.push({
      kind: 'dense',
      label: '高密度弹幕',
      evidence: '存在大量 64 发以上的候选，符合高密度压制型弹幕特征',
      sampleCount: counts.length,
      avgSpeed: Number(avgSpeed.toFixed(2)),
      avgCount: Number(avgCount.toFixed(1)),
      angleSpan: Number(span.toFixed(1)),
    });
  }

  if (out.length === 0) {
    out.push({
      kind: 'unknown',
      label: '未归类弹幕',
      evidence: `提取到 ${candidates.length} 个参数候选，但特征不足以归类`,
      sampleCount: candidates.length,
      avgSpeed: Number(avgSpeed.toFixed(2)),
      avgCount: Number(avgCount.toFixed(1)),
      angleSpan: Number(span.toFixed(1)),
    });
  }
  return out;
}

function emptyResult(layout: string, notes: string[], confidence: number): EclParseResult {
  return {
    layout,
    subCount: 0,
    mainOffset: 0,
    totalInstructions: 0,
    subroutines: [],
    inference: [],
    opcodeHistogram: [],
    speedHistogram: [],
    angleHistogram: [],
    countHistogram: [],
    notes,
    confidence,
  };
}

export function parseEcl(buf: Buffer): EclParseResult {
  const probe = probeLayout(buf);

  if (!probe) {
    return emptyResult(
      'unknown',
      [
        'ECL 头部未通过校验（要求 0x00 为子程序数、0x04 为主时间线偏移、0x08/0x0C 为 0 填充）',
        '未做参数猜测，避免输出不可信的分析结论',
      ],
      0,
    );
  }

  const notes: string[] = [
    `头部校验通过：子程序 ${probe.subCount} 条，主时间线位于 0x${probe.mainOffset.toString(16).toUpperCase()}`,
  ];

  // 主时间线（结构与子程序不同：u16 frame + u16 ×2 + u16 size + args）
  let mainCount = 0;
  {
    let p = probe.mainOffset;
    while (p + 8 <= buf.length && mainCount < MAX_INSTRUCTIONS) {
      const frame = buf.readUInt16LE(p);
      const size = buf.readUInt16LE(p + 6);
      if (frame === 0xffff) break;
      if (size <= 8 || p + size > buf.length) break;
      mainCount++;
      p += size;
    }
  }
  notes.push(`主时间线解析出 ${mainCount} 条指令`);

  // 子程序：按偏移表逐段解析指令流
  const subroutines: EclSubroutine[] = [];
  const allCandidates: BulletParamCandidate[] = [];
  const opcodeCounter = new Map<number, number>();
  let terminatedCount = 0;

  const boundaries = [...probe.subOffsets, buf.length].sort((a, b) => a - b);

  for (let i = 0; i < probe.subOffsets.length; i++) {
    const start = probe.subOffsets[i];
    if (start < 0 || start >= buf.length) continue;
    // 段末取下一个更大的子程序起点，避免偏移未排序时越界
    const end = boundaries.find((b) => b > start) ?? buf.length;

    const { instructions, terminated } = parseInstructions(buf, start, Math.min(end, buf.length));
    if (terminated) terminatedCount++;

    const candidates: BulletParamCandidate[] = [];
    for (const ins of instructions) {
      opcodeCounter.set(ins.opcode, (opcodeCounter.get(ins.opcode) ?? 0) + 1);
      const c = candidatesFromInstruction(ins);
      if (c) candidates.push(c);
    }

    allCandidates.push(...candidates);
    subroutines.push({
      index: i,
      offset: start,
      size: instructions.reduce((a, ins) => a + ins.size, 0),
      instructions: instructions.map<EclInstruction>((ins) => ({
        index: ins.index,
        frame: ins.frame,
        opcode: ins.opcode,
        size: ins.size,
        rankMask: ins.rankMask,
        paramMask: ins.paramMask,
        paramHex: ins.params.toString('hex'),
        paramSize: ins.params.length,
        offset: ins.offset,
      })),
      candidates,
      terminated,
    });
  }

  const totalInstructions = subroutines.reduce((a, s) => a + s.instructions.length, 0);
  notes.push(`子程序共解析出 ${totalInstructions} 条指令，其中 ${terminatedCount}/${subroutines.length} 段正常走到终止标记`);
  notes.push(`从中提取 ${allCandidates.length} 个弹幕参数候选（仅在指令参数区内匹配）`);

  const opcodeHistogram = [...opcodeCounter.entries()]
    .map(([opcode, count]) => ({ opcode, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 40);

  const speedValues = allCandidates.map((c) => c.speed).filter((v): v is number => v !== null);
  const angleValues = allCandidates.map((c) => c.angle).filter((v): v is number => v !== null);
  const countValues = allCandidates.map((c) => c.count).filter((v): v is number => v !== null);

  const terminationRatio = subroutines.length ? terminatedCount / subroutines.length : 0;

  return {
    layout: probe.layout,
    subCount: probe.subCount,
    mainOffset: probe.mainOffset,
    totalInstructions,
    subroutines,
    inference: inferPatterns(allCandidates),
    opcodeHistogram,
    speedHistogram: histogram(speedValues, (v) => Math.round(v * 2) / 2, 2),
    angleHistogram: histogram(angleValues.map((v) => (v * 180) / Math.PI), (v) => Math.round(v / 15) * 15, 2),
    countHistogram: histogram(countValues, (v) => v, 1),
    notes,
    confidence: Number((0.5 + terminationRatio * 0.4).toFixed(2)),
  };
}

export function isEcl(buf: Buffer): boolean {
  return probeLayout(buf) !== null;
}

/* ---------------------------------------------------------------- Boss 阶段分析 */

/**
 * Boss 阶段切分（对应核心算法设计文档第 13 节）。
 *
 * 依据指令流在时间轴上的三个信号切分阶段：
 *   1. 帧间隔突变 —— 长时间空档通常意味着阶段停顿或转场
 *   2. 弹数跃变   —— 超过 2 倍变化视为进入新的弹幕形态
 *   3. 速度跃变   —— 同上
 *
 * 输出的是**结构化推断**，不是游戏内的真实阶段名；
 * 阶段边界与依据都会一并给出，便于人工核对。
 */
export interface BossPhase {
  index: number;
  startFrame: number;
  endFrame: number;
  durationSeconds: number;
  eventCount: number;
  avgCount: number;
  avgSpeed: number;
  subroutines: number[];
  reason: string;
}

export function analyzeBossPhases(result: EclParseResult): BossPhase[] {
  const events: Array<{ frame: number; count: number; speed: number; sub: number }> = [];
  for (const sub of result.subroutines) {
    for (const ins of sub.instructions) {
      const hit = sub.candidates.find((c) => c.byteOffset >= ins.offset && c.byteOffset < ins.offset + ins.size);
      if (hit) events.push({ frame: ins.frame, count: hit.count ?? 0, speed: hit.speed ?? 0, sub: sub.index });
    }
  }
  if (events.length < 2) return [];
  events.sort((a, b) => a.frame - b.frame);

  type Group = { start: number; items: typeof events };
  const groups: Group[] = [];
  let cur: Group = { start: events[0].frame, items: [events[0]] };

  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const e = events[i];
    const gap = e.frame - prev.frame;
    const countRatio = prev.count > 0 && e.count > 0 ? Math.max(e.count / prev.count, prev.count / e.count) : 1;
    const speedRatio = prev.speed > 0 && e.speed > 0 ? Math.max(e.speed / prev.speed, prev.speed / e.speed) : 1;

    // 同一帧内的并发发射属于同一时刻，不切分；
    // 只有跨帧出现长时间空档或弹数/速度跃变时才进入新阶段。
    const crossed = gap > 0;
    if (gap > 180 || (crossed && (countRatio >= 2 || speedRatio >= 2))) {
      groups.push(cur);
      cur = { start: e.frame, items: [e] };
    } else {
      cur.items.push(e);
    }
  }
  groups.push(cur);

  return groups.map((g, i) => {
    const counts = g.items.map((x) => x.count);
    const speeds = g.items.map((x) => x.speed);
    const endFrame = i + 1 < groups.length ? groups[i + 1].start : g.items[g.items.length - 1].frame;
    const prev = i > 0 ? groups[i - 1] : null;

    let reason = '起始阶段';
    if (prev) {
      const gap = g.start - prev.items[prev.items.length - 1].frame;
      const pc = prev.items[prev.items.length - 1].count;
      const cc = g.items[0].count;
      if (gap > 180) reason = `空档 ${gap} 帧后转入`;
      else if (pc > 0 && cc > 0 && Math.max(cc / pc, pc / cc) >= 2) reason = `弹数由 ${pc} 变为 ${cc}`;
      else reason = '速度显著变化';
    }

    return {
      index: i,
      startFrame: g.start,
      endFrame,
      durationSeconds: Number(((endFrame - g.start) / 60).toFixed(2)),
      eventCount: g.items.length,
      avgCount: Number((counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1)),
      avgSpeed: Number((speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(2)),
      subroutines: [...new Set(g.items.map((x) => x.sub))],
      reason,
    };
  });
}
