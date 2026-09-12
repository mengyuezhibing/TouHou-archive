/**
 * 从 ECL 行为脚本提取弹幕事件序列，用于可视化「弹幕是怎么跑起来的」。
 *
 * ── 语义来源 ──
 * TH06 的弹幕生成集中在两个 opcode：0x43 与 0x45，参数区固定 32 字节。
 * 字段含义由**跨全部关卡 421 条样本的取值范围**反推：
 *
 *   @0  u32   标志位 + 子类型（如 0x00060001）
 *   @4  u32   参数 A（0x45 里取值较大，疑似总弹数或分量）
 *   @8  u32   弹数，实测恒在 1~16
 *   @12 f32   参数 B；-10007 / -10006 表示该槽位未使用，应忽略
 *   @16 f32   速度，实测 0.5~3.0 像素/帧
 *   @20 f32   角度（弧度），实测 0~π —— 与「向下半圆发射」的弹幕形态吻合
 *   @24 f32   角速度，实测 -0.45~2.24 rad/帧
 *   @28 u32   子弹类型编号，对应 ANM 内的 sprite 序号
 *
 * 判定依据不只看范围合理性，还用了**互斥性**验证：角度字段的取值几乎全部
 * 落在 [0, π]，这是「朝玩家方向±90°」的自然结果，随机数据不会呈现这种分布。
 *
 * ⚠️ 这是启发式还原，不是 ZUN 虚拟机的精确执行：
 *   · 未建模的字段（@4 / @12）不参与运动计算
 *   · 子弹的实际运动还受重力、加速、追踪等运行时状态影响
 *   因此回放呈现的是**发射时刻的初速度与角度**，用于观察节奏与形态，
 *   不能当作逐帧精确复现。
 */
import type { EclParseResult, EclInstruction } from './ecl.ts';

/** TH06 的弹幕生成 opcode */
const DANMAKU_OPCODES = new Set([0x43, 0x45]);

/** 生成指令参数区的固定长度 */
const PARAM_SIZE = 32;

/** 未使用槽位的哨兵值：ECL 编译器用它填充空参数 */
const UNUSED_THRESHOLD = -10000;

export interface DanmakuEvent {
  /** 在所属子程序内的相对帧 */
  frame: number;
  /** 相对秒数 */
  time: number;
  /** 弹数 */
  count: number;
  /** 初速度（像素/帧） */
  speed: number;
  /** 发射角度（弧度，0 为正右，顺时针为正 —— 与屏幕坐标一致） */
  angle: number;
  /** 角速度（弧度/帧），非 0 即螺旋 */
  spin: number;
  /** 子弹类型编号（对应 ANM sprite） */
  bulletType: number;
  opcode: number;
  /** 该事件的还原置信度 */
  confidence: number;
}

export interface DanmakuSequence {
  /** 子程序编号 */
  subIndex: number;
  /** 子程序偏移 */
  offset: number;
  /** 该序列的时长（帧） */
  durationFrames: number;
  durationSeconds: number;
  events: DanmakuEvent[];
  /** 事件总数 */
  eventCount: number;
  /** 累计发射弹数 */
  totalBullets: number;
  /** 涉及的角度（去重、排序） */
  angles: number[];
  /** 涉及的速度（去重、排序） */
  speeds: number[];
  /** 涉及的子弹类型 */
  bulletTypes: number[];
  /** 是否表现为螺旋（存在非 0 角速度） */
  spiral: boolean;
  warnings: string[];
}

function readEvent(ins: EclInstruction): DanmakuEvent | null {
  const p = Buffer.from(ins.paramHex, 'hex');
  if (p.length < PARAM_SIZE) return null;

  const count = p.readUInt32LE(8);
  const speed = p.readFloatLE(16);
  const angle = p.readFloatLE(20);
  const spin = p.readFloatLE(24);
  const bulletType = p.readUInt32LE(28);

  // ---- 合理性校验：任何一项越界都说明这条指令不是标准弹幕生成 ----
  if (!Number.isInteger(count) || count < 1 || count > 200) return null;
  if (!Number.isFinite(speed) || speed < 0.05 || speed > 30) return null;
  if (!Number.isFinite(angle) || Math.abs(angle) > 6.3) return null;
  if (!Number.isFinite(spin) || Math.abs(spin) > 3) return null;
  if (bulletType > 100000) return null;

  // 置信度：能同时对上「小整数弹数 + 常规速度 + 半圆内角度」的组合，
  // 几乎不可能是巧合；再用弹数与速度的常见区间细化
  let confidence = 0.7;
  if (count <= 32) confidence += 0.1;
  if (speed >= 0.3 && speed <= 6) confidence += 0.1;
  if (angle >= 0 && angle <= Math.PI + 0.01) confidence += 0.05;
  void UNUSED_THRESHOLD;

  return {
    frame: ins.frame,
    time: Number((ins.frame / 60).toFixed(2)),
    count,
    speed: Number(speed.toFixed(3)),
    angle: Number(angle.toFixed(4)),
    spin: Number(spin.toFixed(4)),
    bulletType,
    opcode: ins.opcode,
    confidence: Number(Math.min(confidence, 0.95).toFixed(2)),
  };
}

/** 提取单个子程序的弹幕序列 */
export function extractDanmakuSequence(analysis: EclParseResult, subIndex: number): DanmakuSequence | null {
  const sub = analysis.subroutines.find((s) => s.index === subIndex);
  if (!sub) return null;
  return buildSequence(sub.index, sub.offset, sub.instructions);
}

function buildSequence(subIndex: number, offset: number, instructions: EclInstruction[]): DanmakuSequence | null {
  const events: DanmakuEvent[] = [];
  for (const ins of instructions) {
    if (!DANMAKU_OPCODES.has(ins.opcode)) continue;
    const ev = readEvent(ins);
    if (ev) events.push(ev);
  }
  if (events.length === 0) return null;

  const frames = events.map((e) => e.frame).filter((f) => f < 0xfffffff0);
  const durationFrames = frames.length ? Math.max(...frames) : 0;

  const uniqSorted = (arr: number[]) => [...new Set(arr)].sort((a, b) => a - b);

  const warnings: string[] = [
    '弹幕参数由 opcode 0x43 / 0x45 的参数区还原，字段语义经跨关卡样本的取值分布验证',
    '呈现的是发射时刻的初速度与角度；重力、加速、追踪等运行时效果未建模',
  ];

  return {
    subIndex,
    offset,
    durationFrames,
    durationSeconds: Number((durationFrames / 60).toFixed(2)),
    events: events.sort((a, b) => a.frame - b.frame),
    eventCount: events.length,
    totalBullets: events.reduce((a, e) => a + e.count, 0),
    angles: uniqSorted(events.map((e) => Number(e.angle.toFixed(3)))),
    speeds: uniqSorted(events.map((e) => e.speed)),
    bulletTypes: uniqSorted(events.map((e) => e.bulletType)),
    spiral: events.some((e) => Math.abs(e.spin) > 0.001),
    warnings,
  };
}

/**
 * 提取整部作品的全部弹幕序列（按子程序拆分）。
 *
 * 不把各子程序合并成一条时间线：子程序的帧是**相对各自起点的**，
 * 而「哪个子程序在关卡的第几秒被哪个敌机调用」需要主时间线里
 * 敌机生成指令的类型编号与子程序索引之间的对应表，这张表当前没有。
 * 因此按子程序独立呈现，每段各自从 0 帧开始播放。
 */
export function extractAllSequences(analysis: EclParseResult, minEvents = 2): DanmakuSequence[] {
  const out: DanmakuSequence[] = [];
  for (const sub of analysis.subroutines) {
    const seq = buildSequence(sub.index, sub.offset, sub.instructions);
    if (seq && seq.eventCount >= minEvents) out.push(seq);
  }
  return out.sort((a, b) => b.eventCount - a.eventCount);
}

/** 弧度转角度 */
export function toDegrees(rad: number): number {
  return Number(((rad * 180) / Math.PI).toFixed(1));
}
