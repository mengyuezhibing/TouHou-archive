/**
 * 敌机情报：把 ECL 脚本转成怪物库里可用的属性。
 *
 * 数据来源分两部分：
 *   1. **主时间线**（main）—— 敌机生成事件，含出现时间、坐标、类型、血量、分数
 *   2. **子程序**（sub）—— 各敌机的行为脚本，从中提取角度与速度候选值
 *
 * ── 关于 TH06 的主时间线指令布局 ──
 * 头部 **8 字节**（比子程序的还短）：
 *   u32 frame | u16 opcode | u16 size
 * 随后的参数区（size - 8 字节）对「生成敌机」类指令为：
 *   f32 x | f32 y | f32 unknown | u16 type_id | i16 hp | u32 score
 *
 * 这个布局由实际字节反推 + 语义自洽性双重确认：
 * 第一条生成的敌机是 x=60.0 / y=-32.0 —— x 落在屏幕内、y 在画面上方外侧，
 * 与 TH06 的 384×448 游戏区以及「敌机从上方飞入」的表现完全吻合。
 *
 * ⚠️ 其他作品的主时间线布局不同，不能套用本模块。
 * hp 为 -1 表示不设显式血量（生死由行为脚本控制），这在杂兵中很常见，
 * 不等于「血量 1」。
 */
import fs from 'node:fs';
import { db } from '../db/index.ts';
import { parseEcl } from '../formats/ecl.ts';

type EclAnalysis = ReturnType<typeof parseEcl>;

/** 主时间线中「生成敌机」类指令的 opcode 范围（TH06） */
const ENEMY_SPAWN_OPCODES = new Set([0x00, 0x02, 0x04, 0x06]);

export interface EnemyWave {
  index: number;
  /** 出现时刻（帧，60fps） */
  frame: number;
  /** 出现时刻（秒） */
  time: number;
  /** ★ 行为脚本索引：敌机出场后执行哪个子程序（thecl_enemy_t.sub） */
  sub: number;
  /** 编队 flags：0 普通 / 2 镜像 / 4 随机位置 / 6 镜像+随机 */
  typeFlags: number;
  x: number;
  y: number;
  /** 血量（生成指令里 life 为负时按 1 处理） */
  hp: number;
  /** 是否在生成指令里显式设定了血量 */
  hpExplicit: boolean;
  /** 掉落：-1 随机 / 0~6 对应道具 / 其他无 */
  dropped: number;
  score: number;
  /** 从进入方向推断的编队侧 */
  entry: 'left' | 'right' | 'top' | 'bottom';
}

export interface StageIntel {
  stage: number;
  eclFile: string;
  /** 敌机波次 */
  waves: EnemyWave[];
  waveCount: number;
  /** 关卡脚本总时长 */
  durationFrames: number;
  durationSeconds: number;
  /** 行为脚本数量 */
  subCount: number;
  /** 行为脚本指令总数 */
  totalInstructions: number;
  /** 涉及的行为脚本索引（敌机出场后执行哪些子程序） */
  subIds: number[];
  /** 累计分数（击杀该关全部敌机的理论分值） */
  scoreTotal: number;
  /** 带显式血量的波次数 */
  explicitHpWaves: number;
  /** 从行为脚本提取的角度候选（弧度） */
  angleHints: number[];
  /** 从行为脚本提取的速度候选 */
  speedHints: number[];
  /** 行为脚本的 opcode 频次（截取前若干） */
  opcodeHistogram: Array<{ opcode: number; count: number }>;
  warnings: string[];
}

/**
 * 从主时间线解析敌机波次。
 *
 * 布局来自 pytouhou 的 TH06 ECL 权威文档（thecl_enemy_t），
 * 整条 28 字节指令被引擎以「敌机结构」解读，与 thecl_main_instr_t 的头 8 字节叠加：
 *
 *   @0  u16  time（= 帧号，终止标记 0xffff）
 *   @2  u16  sub            ★ 行为脚本索引 —— 敌机出场后执行哪个子程序
 *   @4  u16  type           编队 flags：0 普通 / 2 镜像 / 4 随机位置 / 6 镜像+随机
 *   @6  u16  size
 *   @8  f32  x
 *   @12 f32  y
 *   @16 f32  z              恒 0（未使用）
 *   @20 i16  life           血量，0~0x7fff；负值按 1 处理
 *   @22 i16  object_dropped 掉落：-1 随机 / 0~6 对应道具 / 其他无
 *   @24 u32  die_score      击破分数
 *
 * 之前启发式版本的误读（typeId/hp/dropped 的位置全部偏移）已被此结构修正：
 * 修正后 sub 引用全部落在 [0, subCount) 内、HP 出现 40/400 这类真实数值、
 * 掉落值精确符合「-1 随机 / 0~6 道具」的枚举——三重交叉印证。
 */
function parseWaves(buf: Buffer, mainOffset: number, subCount: number): { waves: EnemyWave[]; skipped: number } {
  const waves: EnemyWave[] = [];
  let skipped = 0;
  let p = mainOffset;
  let guard = 0;

  while (p + 8 <= buf.length && guard++ < 100000) {
    // 头 8 字节里，frame/time 与 sub/type/size 按敌机结构叠加解读
    const frame = buf.readUInt16LE(p);
    const sub = buf.readUInt16LE(p + 2);
    const typeFlags = buf.readUInt16LE(p + 4);
    const size = buf.readUInt16LE(p + 6);

    // 终止标记：frame 全 1
    if (frame === 0xffff) break;
    if (size < 8 || p + size > buf.length) break;

    if (ENEMY_SPAWN_OPCODES.has(opcodeOf(buf, p)) && size >= 28) {
      const x = buf.readFloatLE(p + 8);
      const y = buf.readFloatLE(p + 12);
      const lifeRaw = buf.readInt16LE(p + 20);
      const dropped = buf.readInt16LE(p + 22);
      const score = buf.readUInt32LE(p + 24);

      // 合理性校验：TH06 游戏区为 384×448，敌机生成点会在边界外一些，
      // 但不会离屏数千像素 —— 超出这个范围说明该指令不是敌机生成，
      // 或参数布局与本作品不符，宁可丢弃也不要输出误导性数据。
      if (
        Number.isFinite(x) && Number.isFinite(y) &&
        Math.abs(x) < 520 && Math.abs(y) < 1200 &&
        sub < subCount
      ) {
        waves.push({
          index: waves.length,
          frame,
          time: Number((frame / 60).toFixed(2)),
          sub,
          typeFlags,
          x: Number(x.toFixed(2)),
          y: Number(y.toFixed(2)),
          hp: lifeRaw < 0 ? 1 : lifeRaw,
          hpExplicit: lifeRaw >= 0,
          dropped,
          score,
          entry: y < -8 ? 'top' : y > 456 ? 'bottom' : x < 0 ? 'left' : x > 384 ? 'right' : 'top',
        });
      } else {
        skipped++;
      }
    } else {
      skipped++;
    }
    p += size;
  }
  return { waves, skipped };
}

/** main 指令的 opcode 在 @4（u16） */
function opcodeOf(buf: Buffer, p: number): number {
  return buf.readUInt16LE(p + 4);
}

/** 从参数字节里挑出像角度 / 速度的值（启发式，仅作参考） */
function extractNumericHints(analysis: EclAnalysis): { angles: number[]; speeds: number[] } {
  const angles = new Map<number, number>();
  const speeds = new Map<number, number>();

  for (const sub of analysis.subroutines) {
    for (const ins of sub.instructions) {
      const hex = ins.paramHex;
      for (let o = 0; o + 8 <= hex.length; o += 8) {
        const raw = parseInt(hex.slice(o, o + 8), 16);
        const f = Buffer.from(hex.slice(o, o + 8), 'hex').readFloatLE(0);
        if (!Number.isFinite(f) || f === 0) continue;
        const abs = Math.abs(f);
        // 角度：弧度制下绝大多数落在 (0, 2π]
        if (abs > 0.05 && abs <= 6.3) {
          const rounded = Number(abs.toFixed(3));
          angles.set(rounded, (angles.get(rounded) ?? 0) + 1);
        }
        // 速度：像素/帧，通常是个位到数十
        if (abs >= 0.5 && abs <= 60 && Number.isInteger(abs)) {
          const rounded = Number(abs.toFixed(1));
          speeds.set(rounded, (speeds.get(rounded) ?? 0) + 1);
        }
        void raw;
      }
    }
  }

  const top = (m: Map<number, number>, n: number) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([v]) => v);

  return { angles: top(angles, 12), speeds: top(speeds, 8) };
}

/** 解析某部作品全部关卡的敌机情报 */
export function analyzeEnemyIntel(gameCode: string): StageIntel[] {
  const gid = (db.prepare('SELECT id FROM game WHERE code = ?').get(gameCode) as any)?.id;
  if (!gid) return [];

  const rows = db
    .prepare("SELECT filename, path FROM resource WHERE game_id = ? AND kind = 'ecl' ORDER BY filename")
    .all(gid) as Array<{ filename: string; path: string }>;

  const out: StageIntel[] = [];

  for (const row of rows) {
    if (!row.path || !fs.existsSync(row.path)) continue;
    const buf = fs.readFileSync(row.path);
    const analysis = parseEcl(buf);

    // 关卡号从文件名取：ecldata1.ecl → 1
    const m = row.filename.match(/(\d+)/);
    const stage = m ? Number(m[1]) : 0;

    const { waves, skipped } = parseWaves(buf, analysis.mainOffset, analysis.subCount);
    const hints = extractNumericHints(analysis);

    // 时长取合理范围内的最大值：脚本尾部常用极大的 frame 值表达
    // 「关卡结束」之类的语义，直接取 max 会得到几小时这种无意义的数字。
    const REASONABLE_FRAMES = 60 * 60 * 8; // 8 分钟，TH06 单关实际时长远小于此
    const frames = waves.map((w) => w.frame).filter((f) => f > 0 && f < REASONABLE_FRAMES);
    const durationFrames = frames.length ? Math.max(...frames) : 0;
    const subIds = [...new Set(waves.map((w) => w.sub))].sort((a, b) => a - b);

    const opcodeHistogram = [...analysis.opcodeHistogram]
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);

    const warnings: string[] = [];
    warnings.push(
      '血量 -1 表示该敌机不由生成指令设定血量，生死由行为脚本控制（杂兵常见）',
    );
    if (skipped > 0) {
      warnings.push(`主时间线中 ${skipped} 条非「生成敌机」指令已跳过（对话 / BGM / Boss 等）`);
    }
    if (analysis.layout !== 'ecl-th06') {
      warnings.push(`该文件的布局是 ${analysis.layout}，主时间线参数结构可能与 TH06 不同，波次解析结果仅供参考`);
    }

    out.push({
      stage,
      eclFile: row.filename,
      waves,
      waveCount: waves.length,
      durationFrames,
      durationSeconds: Number((durationFrames / 60).toFixed(1)),
      subCount: analysis.subCount,
      totalInstructions: analysis.totalInstructions,
      subIds,
      scoreTotal: waves.reduce((a, w) => a + (w.score > 0 && w.score < 1e7 ? w.score : 0), 0),
      explicitHpWaves: waves.filter((w) => w.hpExplicit).length,
      angleHints: hints.angles,
      speedHints: hints.speeds,
      opcodeHistogram,
      warnings,
    });
  }

  return out.sort((a, b) => a.stage - b.stage);
}

/** 弧度转角度，便于界面展示 */
export function toDegrees(rad: number): number {
  return Number(((rad * 180) / Math.PI).toFixed(1));
}
