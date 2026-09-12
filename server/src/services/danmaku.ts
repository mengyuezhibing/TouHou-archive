/**
 * 弹幕模拟引擎（对应设计文档第十节 弹幕编辑器）。
 * 后端负责按参数生成子弹发射时间表，前端按帧渲染，
 * 同一份参数也可直接导出为引擎可用资源。
 */

export type DanmakuType = 'ring' | 'fan' | 'spiral' | 'random' | 'laser' | 'aimed' | 'wave' | 'homing';

export interface DanmakuParams {
  type: DanmakuType;
  /** 每波弹数 */
  count: number;
  /** 基础速度（单位/秒） */
  speed: number;
  /** 中心角度（度，0 = 正上方，顺时针为正） */
  angle: number;
  /** 扇形张角（度），ring 忽略 */
  spread: number;
  /** 每波旋转角（度），spiral 模式下逐波累加 */
  rotationPerWave: number;
  /** 是否整体旋转 */
  rotation: boolean;
  /** 每帧旋转速度（度/秒） */
  rotationSpeed: number;
  /** 波数 */
  waves: number;
  /** 波间隔（帧，60fps） */
  waveInterval: number;
  /** 加速度（单位/秒²，负值为减速） */
  accel: number;
  /** 角度抖动（度） */
  jitter: number;
  /** 速度抖动（0-1 比例） */
  speedJitter: number;
  /** 发射原点（归一化 0-1，左上为原点） */
  origin: { x: number; y: number };
  /** 恒定转向率（度/秒），homing 类型使用；子弹将沿圆弧飞行 */
  turnSpeed: number;
  /** 波浪频率（Hz），wave 类型使用 */
  frequency: number;
  /** 波浪振幅（单位），wave 类型使用 */
  amplitude: number;
  /** 随机种子，保证可复现 */
  seed: number;
}

export const DEFAULT_DANMAKU: DanmakuParams = {
  type: 'ring',
  count: 32,
  speed: 90,
  angle: 0,
  spread: 360,
  rotationPerWave: 11.25,
  rotation: true,
  rotationSpeed: 0,
  waves: 6,
  waveInterval: 24,
  accel: 0,
  jitter: 0,
  speedJitter: 0,
  origin: { x: 0.5, y: 0.28 },
  turnSpeed: 0,
  frequency: 1.2,
  amplitude: 18,
  seed: 20250811,
};

export interface SimBullet {
  id: number;
  wave: number;
  index: number;
  /** 发射角度（度） */
  angle: number;
  speed: number;
  accel: number;
  /** 出现帧 */
  spawnFrame: number;
  /** 相对原点的初始偏移（归一化） */
  offset: { x: number; y: number };
  /**
   * 波浪参数（文档第 9.3 节）。
   * 运动学：沿初始方向直线前进，同时沿垂直方向做正弦偏移
   *   offset(t) = sin(2π·frequency·t) · amplitude
   */
  waveMotion?: { frequency: number; amplitude: number };
  /**
   * 追踪转向率（文档第 9.4 节，度/秒）。
   * 恒定转向率下弹道为圆弧，解析解：
   *   P(t) = P₀ + (v/ω)·[ sin(ωt)·d₀ + (1−cos(ωt))·n ]，n 为 d₀ 逆时针 90°
   */
  turnSpeed?: number;
}

export interface SimResult {
  params: DanmakuParams;
  bullets: SimBullet[];
  totalFrames: number;
  stats: {
    bulletCount: number;
    waves: number;
    avgSpeed: number;
    angleSpan: number;
    densityPerSecond: number;
  };
}

/** 确定性伪随机（mulberry32），保证同一 seed 结果稳定 */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function simulateDanmaku(input: Partial<DanmakuParams>): SimResult {
  const p: DanmakuParams = { ...DEFAULT_DANMAKU, ...input, origin: { ...DEFAULT_DANMAKU.origin, ...(input.origin ?? {}) } };
  const rand = makeRandom(p.seed);
  const bullets: SimBullet[] = [];

  const count = Math.max(1, Math.min(512, Math.round(p.count)));
  const waves = Math.max(1, Math.min(200, Math.round(p.waves)));
  const interval = Math.max(1, Math.min(600, Math.round(p.waveInterval)));

  for (let w = 0; w < waves; w++) {
    const spawnFrame = w * interval;
    const baseAngle = p.rotation ? p.angle + p.rotationSpeed * ((spawnFrame / 60) * 60) + p.rotationPerWave * w : p.angle;

    for (let i = 0; i < count; i++) {
      let angleDeg: number;

      switch (p.type) {
        case 'ring':
          angleDeg = (360 / count) * i + baseAngle;
          break;
        case 'fan': {
          const half = p.spread / 2;
          const t = count === 1 ? 0.5 : i / (count - 1);
          angleDeg = baseAngle - half + p.spread * t;
          break;
        }
        case 'spiral':
          angleDeg = baseAngle + (360 / (count * 2)) * i;
          break;
        case 'random':
          angleDeg = baseAngle + (rand() - 0.5) * 360;
          break;
        case 'aimed':
          angleDeg = baseAngle + (rand() - 0.5) * p.spread;
          break;
        case 'laser': {
          const t = count === 1 ? 0.5 : i / (count - 1);
          angleDeg = baseAngle - p.spread / 2 + p.spread * t;
          break;
        }
        case 'wave':
          // 波浪弹以全方位铺开，靠各子弹自身的正弦偏移形成波面
          angleDeg = (360 / count) * i + baseAngle;
          break;
        case 'homing':
          // 追踪弹初始沿扇形散开，随后按 turnSpeed 逐帧转向
          angleDeg = baseAngle + (count === 1 ? 0 : (i / (count - 1) - 0.5) * (p.spread || 30));
          break;
        default:
          angleDeg = baseAngle;
      }

      if (p.jitter > 0) angleDeg += (rand() - 0.5) * p.jitter;
      const speed = p.speed * (1 + (p.speedJitter > 0 ? (rand() - 0.5) * p.speedJitter : 0));

      const bullet: SimBullet = {
        id: w * count + i,
        wave: w,
        index: i,
        angle: Number(angleDeg.toFixed(3)),
        speed: Number(speed.toFixed(2)),
        accel: p.accel,
        spawnFrame,
        offset: { x: 0, y: 0 },
      };

      if (p.type === 'wave' && p.amplitude > 0) {
        bullet.waveMotion = { frequency: p.frequency, amplitude: p.amplitude };
      }
      if (p.type === 'homing' && p.turnSpeed !== 0) {
        bullet.turnSpeed = p.turnSpeed;
      }

      bullets.push(bullet);
    }
  }

  const speeds = bullets.map((b) => b.speed);
  const angles = bullets.map((b) => ((b.angle % 360) + 360) % 360);
  const span = angles.length ? Math.max(...angles) - Math.min(...angles) : 0;
  const totalFrames = waves > 0 ? (waves - 1) * interval + 1 : 0;

  return {
    params: p,
    bullets,
    totalFrames,
    stats: {
      bulletCount: bullets.length,
      waves,
      avgSpeed: Number((speeds.reduce((a, b) => a + b, 0) / Math.max(1, speeds.length)).toFixed(1)),
      angleSpan: Number(span.toFixed(1)),
      densityPerSecond: Number(((bullets.length / Math.max(1, totalFrames)) * 60).toFixed(1)),
    },
  };
}

/** 生成分析用的模式画像（用于与 ECL 分析结果对比） */
export function describePattern(p: DanmakuParams): { kind: string; label: string } {
  switch (p.type) {
    case 'ring':
      return { kind: 'ring', label: '环形弹' };
    case 'fan':
      return { kind: 'fan', label: '扇形散弹' };
    case 'spiral':
      return { kind: 'spiral', label: '旋转螺旋弹' };
    case 'random':
      return { kind: 'random', label: '随机散射' };
    case 'laser':
      return { kind: 'laser', label: '激光列' };
    case 'aimed':
      return { kind: 'aimed', label: '自机狙' };
    case 'wave':
      return { kind: 'wave', label: '波浪弹（正弦扰动）' };
    case 'homing':
      return { kind: 'homing', label: '追踪弹（恒定转向率圆弧）' };
    default:
      return { kind: 'unknown', label: '未知' };
  }
}

/**
 * 子弹在时刻 t 的位移（相对发射原点），供前端按帧渲染。
 * 三类运动学：
 *   直线      dist = v·t + ½a·t²
 *   波浪      直线位移 + 垂直方向正弦偏移
 *   追踪      恒定转向率 → 圆弧解析解
 */
export function bulletPosition(
  b: SimBullet,
  t: number,
): { x: number; y: number } {
  const rad = (b.angle * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad); // 屏幕坐标：角度 0 指向正上方

  const dist = b.speed * t + 0.5 * b.accel * t * t;

  if (b.waveMotion) {
    const dist2 = Math.max(0, dist);
    const offset = Math.sin(2 * Math.PI * b.waveMotion.frequency * t) * b.waveMotion.amplitude;
    // 垂直方向 = 前进方向逆时针 90°
    return { x: dx * dist2 + -dy * offset, y: dy * dist2 + dx * offset };
  }

  if (b.turnSpeed) {
    const omega = (b.turnSpeed * Math.PI) / 180; // 弧度/秒
    const theta = omega * t;
    const radius = b.speed / omega;
    // 法向量 n = d₀ 逆时针 90°
    const nx = -dy;
    const ny = dx;
    // P(t) = P₀ + (v/ω)·[ sin(θ)·d₀ + (1−cos(θ))·n ]
    return {
      x: radius * (Math.sin(theta) * dx + (1 - Math.cos(theta)) * nx),
      y: radius * (Math.sin(theta) * dy + (1 - Math.cos(theta)) * ny),
    };
  }

  return { x: dx * dist, y: dy * dist };
}

/** 导出为 Godot 4 可用的 GDScript 常量表 */
export function exportGodotScript(name: string, result: SimResult): string {
  const { params, bullets } = result;
  const rows = bullets
    .slice(0, 2000)
    .map((b) => `\t{"wave": ${b.wave}, "angle": ${b.angle}, "speed": ${b.speed}, "spawn_frame": ${b.spawnFrame}},`)
    .join('\n');
  return `# 由 Touhou Resource Studio 导出
# 弹幕模式：${name}
# 类型：${params.type}  弹数/波：${params.count}  波数：${params.waves}
extends Node

const PATTERN_NAME := "${name}"
const ORIGIN := Vector2(${params.origin.x}, ${params.origin.y})
const ACCEL := ${params.accel}

# 每颗子弹：发射角度（度） / 速度 / 出现帧
const BULLETS: Array[Dictionary] = [
${rows}
]

## 逐帧驱动的示例：
## for b in BULLETS:
##     if frame == b["spawn_frame"]:
##         spawn_bullet(ORIGIN, deg_to_rad(b["angle"] - 90), b["speed"])
func spawn_bullet(origin: Vector2, dir: float, speed: float) -> void:
\tvar v := Vector2.RIGHT.rotated(dir) * speed
\t# TODO: 实例化你的子弹场景并设置 velocity
\tpass
`;
}

/** 导出为通用 JSON（Unity / Unreal / 自研引擎均可解析） */
export function exportPatternJson(name: string, result: SimResult, meta: Record<string, unknown> = {}) {
  return {
    schema: 'touhou-resource-studio.danmaku/1',
    name,
    exportedAt: new Date().toISOString(),
    params: result.params,
    stats: result.stats,
    bullets: result.bullets,
    ...meta,
  };
}
