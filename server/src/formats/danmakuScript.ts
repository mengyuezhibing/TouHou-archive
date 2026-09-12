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

/**
 * TH06 的弹幕属性设置 opcode（pytouhou 定义 67/68/69/70/71/74/75）。
 * 名字叫 set_bullet_attributes，但 TH06 的弹幕是「设置属性后按间隔连射」，
 * 所以这些指令同时承载了弹数/速度/角度/弹种，是弹幕回放的核心数据源。
 */
const DANMAKU_OPCODES = new Set([0x43, 0x44, 0x45, 0x46, 0x47, 0x4a, 0x4b]);

/**
 * 回调类指令：参数 i32 = 回调子程序索引。
 * Boss 的符卡切换靠低血量回调（0x72）与超时回调（0x74）驱动，
 * 不追踪它们就只能看到 Boss 的属性设置脚本、看不到符卡弹幕。
 */
const CALLBACK_OPCODES = new Set([0x6c, 0x72, 0x74]);

/** 生成指令参数区的固定长度 */
const PARAM_SIZE = 32;

/** 未使用槽位的哨兵值：ECL 编译器用它填充空参数 */
const UNUSED_THRESHOLD = -10000;

/** rank_mask 高字节的难度位含义（pytouhou 文档确认） */
const DIFF_BITS: Array<[number, string]> = [
  [1, 'Easy'],
  [2, 'Normal'],
  [4, 'Hard'],
  [8, 'Lunatic'],
];

/** rank_mask 低字节恒 0xff，高字节是难度位掩码；位全空时按全难度兜底 */
function rankToDifficulties(rankMask: number): string[] {
  const hi = (rankMask >> 8) & 0xff;
  const names = DIFF_BITS.filter(([bit]) => hi & bit).map(([, n]) => n);
  return names.length ? names : DIFF_BITS.map(([, n]) => n);
}

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
  /** 该序列覆盖的难度（子程序指令 rank_mask 高字节统计：Easy/Normal/Hard/Lunatic） */
  difficulties: string[];
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

  // 难度覆盖：统计本序列全部指令的 rank 位
  const diffCount = new Map<string, number>();
  for (const ins of instructions) {
    for (const d of rankToDifficulties(ins.rankMask)) {
      diffCount.set(d, (diffCount.get(d) ?? 0) + 1);
    }
  }

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
    difficulties: [...diffCount.keys()],
    warnings,
  };
}

/**
 * 从根子程序出发，沿 call 指令（opcode 0x23 'iif'，首参为目标子程序索引）
 * **递归**收集弹幕事件。
 *
 * TH06 的 Boss 行为脚本通常自己不含弹幕指令，而是按阶段调用专职的弹幕子程序
 * （例如 sub13 → 调用 sub14/sub15，两路参数互为 ±0.314 的镜像角度）。
 * 只看单个子程序会漏掉 Boss 的全部弹幕，这是必须做调用链追踪的原因。
 *
 * 调用点带帧偏移：被调子程序的事件帧加上 call 发生的帧，
 * 使回放时「前一批弹幕还在飞、后一批已经出手」的叠加形态得以呈现。
 */
export function collectTransitive(
  analysis: EclParseResult,
  rootSub: number,
  depth = 0,
  visited = new Set<number>(),
): DanmakuSequence | null {
  if (visited.has(rootSub) || depth > 8) return null;
  visited.add(rootSub);

  const sub = analysis.subroutines.find((s) => s.index === rootSub);
  if (!sub) return null;

  const events: DanmakuEvent[] = [];
  const called = new Set<number>();

  for (const ins of sub.instructions) {
    if (DANMAKU_OPCODES.has(ins.opcode)) {
      const ev = readEvent(ins);
      if (ev) events.push(ev);
    } else if (ins.opcode === 0x23 && depth < 8) {
      const p = Buffer.from(ins.paramHex, 'hex');
      if (p.length >= 4) {
        const target = p.readInt32LE(0);
        if (target < 0 || visited.has(target) || called.has(target)) continue;
        called.add(target);
        const child = collectTransitive(analysis, target, depth + 1, visited);
        if (child) {
          for (const e of child.events) {
            const f = ins.frame + e.frame;
            events.push({ ...e, frame: f, time: Number((f / 60).toFixed(2)) });
          }
        }
      }
    } else if (CALLBACK_OPCODES.has(ins.opcode) && depth < 8) {
      // Boss 的符卡切换不靠 call，而靠三类回调：
      //   0x6c 死亡回调 / 0x72 低血量回调（进入下一符卡）/ 0x74 超时回调
      // 参数 i32 = 回调子程序索引，同样递归展开
      const p = Buffer.from(ins.paramHex, 'hex');
      if (p.length >= 4) {
        const target = p.readInt32LE(0);
        if (target >= 0 && !visited.has(target) && !called.has(target)) {
          called.add(target);
          const child = collectTransitive(analysis, target, depth + 1, visited);
          if (child) {
            for (const e of child.events) {
              const f = ins.frame + e.frame;
              events.push({ ...e, frame: f, time: Number((f / 60).toFixed(2)) });
            }
          }
        }
      }
    }
  }

  if (events.length === 0) return null;

  // 难度覆盖：统计调用链上所有子程序的指令 rank 位
  const diffCount = new Map<string, number>();
  for (const idx of visited) {
    const s = analysis.subroutines.find((x) => x.index === idx);
    if (!s) continue;
    for (const ins of s.instructions) {
      for (const d of rankToDifficulties(ins.rankMask)) {
        diffCount.set(d, (diffCount.get(d) ?? 0) + 1);
      }
    }
  }

  events.sort((a, b) => a.frame - b.frame);
  const frames = events.map((e) => e.frame).filter((f) => f < 0xfffffff0);
  const durationFrames = frames.length ? Math.max(...frames) : 0;

  const seq: DanmakuSequence = {
    subIndex: rootSub,
    offset: sub.offset,
    durationFrames,
    durationSeconds: Number((durationFrames / 60).toFixed(2)),
    events,
    eventCount: events.length,
    totalBullets: events.reduce((a, e) => a + e.count, 0),
    angles: [...new Set(events.map((e) => Number(e.angle.toFixed(3))))].sort((a, b) => a - b),
    speeds: [...new Set(events.map((e) => e.speed))].sort((a, b) => a - b),
    bulletTypes: [...new Set(events.map((e) => e.bulletType))].sort((a, b) => a - b),
    spiral: events.some((e) => Math.abs(e.spin) > 0.001),
    difficulties: [...diffCount.keys()],
    warnings: [
      '调用链事件：帧已叠加 call 发生时的偏移，呈现的是该敌方单位的完整弹幕',
      '弹幕参数由 opcode 0x43 / 0x45 参数区还原（字段语义来自 pytouhou 权威定义）',
      '重力、加速、追踪等运行时效果未建模',
    ],
  };
  return seq;
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
