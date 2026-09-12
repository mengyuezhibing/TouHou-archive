/**
 * 弹幕中间语言 BIR（Bullet Intermediate Representation）。
 *
 * 对应《核心算法设计文档》第 6/7 节：**工具不直接消费 ECL**。
 * ECL 是 ZUN 自研虚拟机的字节码，指令表随作品版本变化；
 * 因此解析后先归一化为与引擎无关的 BIR，再由 BIR 驱动：
 *
 *   ECL ──Lexer/Parser──▶ 指令树 ──▶ BIR ──▶ 模拟 / 编辑 / 导出
 *
 * BIR 的形态：
 *   { pattern: "spiral", events: [ { time: 0, action: "spawn", count: 8, speed: 3 } ] }
 */

export const BIR_SCHEMA = 'trs.bir/1';

export type BirAction =
  | 'spawn'   // 生成一批子弹
  | 'rotate'  // 改变后续批次的基础角度
  | 'accel'   // 改变加速度
  | 'wait'    // 空档
  | 'laser'   // 激光
  | 'clear'   // 清弹
  | 'wave'    // 波浪运动
  | 'homing'  // 追踪
  | 'fade';   // 减速 / 消失

export interface BirEvent {
  /** 相对时间（秒） */
  time: number;
  action: BirAction;
  count?: number;
  speed?: number;
  angle?: number;
  spread?: number;
  /** 通用数值载荷（rotate 的角度增量、accel 的加速度等） */
  value?: number;
  duration?: number;
  frequency?: number;
  amplitude?: number;
  turnSpeed?: number;
  radius?: number;
  /** 来源追溯：opcode / 子程序 / 置信度 */
  source?: Record<string, unknown>;
}

export interface BirPattern {
  schema: string;
  name: string;
  /** circle | spiral | laser | wave | random | aimed | dense | unknown */
  pattern: string;
  duration: number;
  events: BirEvent[];
  meta: Record<string, unknown>;
}

/* ---------------------------------------------------------------- 构造 */

export interface ActionRow {
  time: number;
  action_type: string;
  parameter: Record<string, unknown>;
}

/** 数据库动作行 → BIR */
export function actionsToBir(
  name: string,
  pattern: string,
  actions: ActionRow[],
  meta: Record<string, unknown> = {},
): BirPattern {
  const events: BirEvent[] = actions.map((a) => {
    const p = a.parameter ?? {};
    const ev: BirEvent = { time: Number(a.time ?? 0), action: (a.action_type as BirAction) ?? 'spawn' };

    if (p.count !== undefined) ev.count = Number(p.count);
    if (p.speed !== undefined) ev.speed = Number(p.speed);
    if (p.angle !== undefined) ev.angle = Number(p.angle);
    if (p.spread !== undefined) ev.spread = Number(p.spread);
    if (p.value !== undefined) ev.value = Number(p.value);
    if (p.duration !== undefined) ev.duration = Number(p.duration);
    if (p.frequency !== undefined) ev.frequency = Number(p.frequency);
    if (p.amplitude !== undefined) ev.amplitude = Number(p.amplitude);
    if (p.turnSpeed !== undefined) ev.turnSpeed = Number(p.turnSpeed);
    if (p.radius !== undefined) ev.radius = Number(p.radius);

    const src: Record<string, unknown> = {};
    for (const k of ['opcode', 'subroutine', 'confidence'] as const) {
      if (p[k] !== undefined) src[k] = p[k];
    }
    if (Object.keys(src).length) ev.source = src;

    return ev;
  });

  const duration = events.length ? Math.max(...events.map((e) => e.time)) : 0;
  return { schema: BIR_SCHEMA, name, pattern, duration: Number(duration.toFixed(3)), events, meta };
}

/** BIR → 数据库动作行 */
export function birToActions(bir: BirPattern): ActionRow[] {
  return bir.events.map((e) => {
    const parameter: Record<string, unknown> = {};
    for (const k of ['count', 'speed', 'angle', 'spread', 'value', 'duration', 'frequency', 'amplitude', 'turnSpeed', 'radius'] as const) {
      if (e[k] !== undefined) parameter[k] = e[k];
    }
    if (e.source) Object.assign(parameter, e.source);
    return { time: e.time, action_type: e.action, parameter };
  });
}

/* ---------------------------------------------------------------- 校验与推断 */

export function validateBir(input: unknown): { ok: boolean; errors: string[]; bir?: BirPattern } {
  const errors: string[] = [];
  const p = input as Partial<BirPattern> | null;
  if (!p || typeof p !== 'object') return { ok: false, errors: ['不是对象'] };
  if (!p.pattern) errors.push('缺少 pattern 字段');
  if (!Array.isArray(p.events)) errors.push('events 必须是数组');
  else {
    p.events.forEach((e, i) => {
      if (typeof e.time !== 'number' || e.time < 0) errors.push(`events[${i}].time 必须是非负数`);
      if (!e.action) errors.push(`events[${i}].action 缺失`);
    });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], bir: { ...(p as BirPattern), schema: BIR_SCHEMA } };
}

/**
 * 从事件序列推断弹幕形态（对应文档第 10 节弹幕分类算法）。
 * 判据：弹数分布 / 角度跨度 / 时间维度上的角度变化。
 */
export function inferBirPattern(events: BirEvent[]): string {
  const spawns = events.filter((e) => e.action === 'spawn');
  if (!spawns.length) return 'unknown';

  const counts = spawns.map((e) => e.count).filter((c): c is number => typeof c === 'number');
  const avgCount = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
  const angles = spawns.map((e) => e.angle).filter((a): a is number => typeof a === 'number');
  const span = angles.length ? Math.max(...angles) - Math.min(...angles) : 0;
  const hasRotate = events.some((e) => e.action === 'rotate');
  const hasWave = spawns.some((e) => (e.frequency ?? 0) > 0);
  const hasHoming = spawns.some((e) => (e.turnSpeed ?? 0) > 0);
  const hasLaser = events.some((e) => e.action === 'laser');

  if (hasWave) return 'wave';
  if (hasHoming) return 'homing';
  if (hasLaser) return 'laser';
  // 角度在时间轴上持续推进 → 螺旋
  if (hasRotate || (angles.length > 2 && span > 300)) return 'spiral';
  if (avgCount >= 12 && span > 180) return 'circle';
  if (avgCount >= 3 && span <= 120) return 'fan';
  if (avgCount <= 1) return 'single';
  return 'unknown';
}

/* ---------------------------------------------------------------- 转换 */

export interface SimBulletLike {
  wave?: { frequency: number; amplitude: number };
  turnSpeed?: number;
}

/** BIR → 弹幕模拟参数（供预览器使用） */
export function birToSimParams(bir: BirPattern): {
  type: string;
  count: number;
  speed: number;
  angle: number;
  spread: number;
  waves: number;
  waveInterval: number;
  rotationPerWave: number;
  turnSpeed: number;
  frequency: number;
  amplitude: number;
} {
  const spawns = bir.events.filter((e) => e.action === 'spawn');
  const first = spawns[0] ?? {};
  const interval = spawns.length > 1 ? (spawns[spawns.length - 1].time - spawns[0].time) / Math.max(1, spawns.length - 1) : 1;
  const rotateEvents = bir.events.filter((e) => e.action === 'rotate');
  const rotationPerWave = rotateEvents.length ? Number(rotateEvents[0].value ?? 0) : 0;

  const typeMap: Record<string, string> = {
    circle: 'ring',
    spiral: 'spiral',
    fan: 'fan',
    wave: 'wave',
    homing: 'homing',
    laser: 'laser',
    random: 'random',
    single: 'aimed',
  };

  return {
    type: typeMap[bir.pattern] ?? 'ring',
    count: Number(first.count ?? 16),
    speed: Number(first.speed ?? 90),
    angle: Number(first.angle ?? 0),
    spread: bir.pattern === 'fan' ? 60 : 360,
    waves: Math.max(1, spawns.length),
    waveInterval: Math.max(2, Math.round(interval * 60)),
    rotationPerWave,
    turnSpeed: Number(first.turnSpeed ?? 0),
    frequency: Number(first.frequency ?? 1),
    amplitude: Number(first.amplitude ?? 20),
  };
}

/* ---------------------------------------------------------------- 导出 */

/** BIR → Godot GDScript */
export function birToGodot(bir: BirPattern): string {
  // duration 可能未显式给出，此处按最后一个事件时间补算
  const duration = Number.isFinite(bir.duration) && bir.duration > 0
    ? bir.duration
    : bir.events.reduce((a, e) => Math.max(a, e.time), 0);

  const rows = bir.events
    .map((e) => {
      const payload = JSON.stringify({ time: e.time, action: e.action, count: e.count, speed: e.speed, angle: e.angle, value: e.value })
        .replace(/"([a-z_]+)":/g, '"$1":');
      return `\t${payload},`;
    })
    .join('\n');

  return `# 由 东方资源研究工作台 导出（BIR ${BIR_SCHEMA}）
# 模式：${bir.name}   形态：${bir.pattern}   时长：${duration}s
extends Node

const PATTERN_NAME := "${bir.name}"
const PATTERN_KIND := "${bir.pattern}"
const DURATION := ${duration}

## 事件序列：time(秒) / action / 参数
const EVENTS: Array[Dictionary] = [
${rows}
]

## 按时间轴驱动（示例）
## for e in EVENTS:
##     await wait_seconds(e["time"] - current_time)
##     match e["action"]:
##         "spawn": _spawn_bullets(e.get("count", 1), e.get("speed", 100.0), e.get("angle", 0.0))
func _spawn_bullets(count: int, speed: float, angle_deg: float) -> void:
\tfor i in count:
\t\tvar a := deg_to_rad(angle_deg + 360.0 * i / count)
\t\tvar dir := Vector2.RIGHT.rotated(a - PI / 2)
\t\t# TODO: 实例化子弹场景，设置 velocity = dir * speed
\t\tpass
`;
}

/** BIR → Unity 友好的结构 */
export function birToUnity(bir: BirPattern): Record<string, unknown> {
  return {
    schema: 'trs.unity.bir/1',
    displayName: bir.name,
    patternKind: bir.pattern,
    durationSeconds: bir.duration,
    events: bir.events.map((e) => ({
      time: e.time,
      action: e.action,
      count: e.count ?? null,
      speed: e.speed ?? null,
      angleDeg: e.angle ?? null,
      value: e.value ?? null,
    })),
  };
}
