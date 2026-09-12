<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api, type DanmakuSequence, type FieldEvent, type StageField, type StageSequences } from '../api.ts';
import { store } from '../store.ts';

/**
 * ECL 弹幕回放：把行为脚本里还原出的发射事件逐帧演算出来。
 *
 * 两种模式：
 *   · 关卡弹幕场（默认）—— 该关全部子程序合并，各自挂到从主时间线提取的
 *     真实敌机坐标上，看到的是「这一关的弹幕长什么样」
 *   · 单序列       —— 只看某个行为脚本内部的编排（节奏、层数、螺旋）
 *
 * 渲染：每帧按事件生成子弹，再对所有子弹做一次位置积分。只维护 60fps 的一份
 * 状态，不做全帧预计算（1000+ 发弹时会很占内存）。子弹带拖尾，以便看清运动轨迹。
 */

/** TH06 游戏区尺寸，按真实比例呈现 */
const PLAY_W = 384;
const PLAY_H = 448;

type Mode = 'field' | 'seq';

const mode = ref<Mode>('field');
const stageSeq = ref<StageSequences[]>([]);
const fields = ref<StageField[]>([]);
const stage = ref<number | null>(null);
const seqIndex = ref(0);
const loading = ref(false);
const err = ref('');

const playing = ref(false);
const speed = ref(1);
const frame = ref(0);
const totalFrames = ref(600);

const canvasRef = ref<HTMLCanvasElement | null>(null);
let raf = 0;
type Bullet = { x: number; y: number; px: number; py: number; angle: number; speed: number; spin: number; type: number };
let bullets: Bullet[] = [];

const currentSeqStage = computed(() => stageSeq.value.find((s) => s.stage === stage.value) ?? null);
const sequences = computed(() => currentSeqStage.value?.sequences ?? []);
const seq = computed<DanmakuSequence | null>(() => sequences.value[seqIndex.value] ?? null);
const field = computed<StageField | null>(() => fields.value.find((f) => f.stage === stage.value) ?? null);

/**
 * 当前播放用的事件，统一成「带发射源」的格式，让两种模式共用同一套演算逻辑。
 * 单序列模式没有真实坐标可用，退化为画面中央偏上的单一发射源。
 */
const activeEvents = computed<FieldEvent[]>(() => {
  if (mode.value === 'field') return field.value?.events ?? [];
  const s = seq.value;
  if (!s) return [];
  return s.events.map((e) => ({
    originX: PLAY_W / 2,
    originY: PLAY_H * 0.3,
    frame: e.frame,
    count: e.count,
    speed: e.speed,
    angle: e.angle,
    spin: e.spin,
    bulletType: e.bulletType,
    subIndex: s.subIndex,
  }));
});

/** 发射源列表（弹幕场模式下用于绘制标记） */
const origins = computed(() => field.value?.sources ?? []);

const TYPE_COLORS = ['#e8c547', '#7da266', '#5f93b8', '#9a86bd', '#b8563f', '#5aa39b'];
const colorOf = (t: number) => TYPE_COLORS[Math.abs(t) % TYPE_COLORS.length];

async function load() {
  const gameId = store.currentGameId;
  if (!gameId) {
    stageSeq.value = [];
    fields.value = [];
    return;
  }
  loading.value = true;
  err.value = '';
  try {
    const [s, f] = await Promise.all([api.danmakuSequences(gameId), api.danmakuFields(gameId)]);
    stageSeq.value = s.stages;
    fields.value = f.stages;
    if (fields.value.length) {
      stage.value = fields.value[0].stage;
      seqIndex.value = 0;
    }
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

function reset() {
  playing.value = false;
  cancelAnimationFrame(raf);
  frame.value = 0;
  bullets = [];
  const dur =
    mode.value === 'field' ? (field.value?.durationFrames ?? 0) : (seq.value?.durationFrames ?? 0);
  // 播放时长 = 脚本时长 + 4 秒余量，让最后一批子弹有时间飞出画面
  totalFrames.value = Math.max(240, Math.min(dur + 240, 5400));
  draw();
}

/** 推进一帧 */
function step() {
  const evs = activeEvents.value;
  const f = frame.value;

  for (const ev of evs) {
    if (ev.frame !== f) continue;
    for (let i = 0; i < ev.count; i++) {
      const a = ev.angle + (i / ev.count) * Math.PI * 2;
      bullets.push({
        x: ev.originX,
        y: ev.originY,
        px: ev.originX,
        py: ev.originY,
        angle: a,
        speed: ev.speed,
        spin: ev.spin,
        type: ev.bulletType,
      });
    }
  }

  for (const b of bullets) {
    b.px = b.x;
    b.py = b.y;
    b.angle += b.spin;
    b.x += Math.cos(b.angle) * b.speed;
    b.y += Math.sin(b.angle) * b.speed;
  }

  const M = 48;
  bullets = bullets.filter((b) => b.x > -M && b.x < PLAY_W + M && b.y > -M && b.y < PLAY_H + M);
}

function draw() {
  const cv = canvasRef.value;
  if (!cv) return;
  const ctx = cv.getContext('2d');
  if (!ctx) return;

  ctx.fillStyle = '#0e100c';
  ctx.fillRect(0, 0, PLAY_W, PLAY_H);

  ctx.strokeStyle = 'rgba(125,162,102,0.10)';
  ctx.lineWidth = 1;
  for (let x = 48; x < PLAY_W; x += 48) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, PLAY_H);
    ctx.stroke();
  }
  for (let y = 48; y < PLAY_H; y += 48) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(PLAY_W, y);
    ctx.stroke();
  }

  // 发射源标记（敌机出场位置）
  if (mode.value === 'field') {
    for (const o of origins.value) {
      ctx.fillStyle = 'rgba(184,144,42,0.55)';
      ctx.fillRect(o.x - 3, o.y - 3, 6, 6);
    }
  } else {
    ctx.fillStyle = 'rgba(184,144,42,0.9)';
    ctx.beginPath();
    ctx.arc(PLAY_W / 2, PLAY_H * 0.3, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // 拖尾：从上一位置到当前位置画一段线，让运动方向可见
  for (const b of bullets) {
    ctx.strokeStyle = colorOf(b.type);
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(b.px, b.py);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // 弹体
  for (const b of bullets) {
    ctx.fillStyle = colorOf(b.type);
    ctx.beginPath();
    ctx.arc(b.x, b.y, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function tick() {
  if (!playing.value) return;
  const steps = Math.max(1, Math.round(speed.value));
  for (let i = 0; i < steps; i++) {
    if (frame.value >= totalFrames.value) {
      playing.value = false;
      break;
    }
    frame.value++;
    step();
  }
  draw();
  raf = requestAnimationFrame(tick);
}

function togglePlay() {
  if (playing.value) {
    playing.value = false;
    cancelAnimationFrame(raf);
    return;
  }
  if (frame.value >= totalFrames.value) reset();
  playing.value = true;
  raf = requestAnimationFrame(tick);
}

/** 拖动进度：从 0 快进，保证子弹状态连续 */
function seek(target: number) {
  frame.value = 0;
  bullets = [];
  for (let f = 0; f <= target; f++) {
    frame.value = f;
    step();
  }
  frame.value = target;
  draw();
}

watch(() => store.currentGameId, () => {
  stage.value = null;
  load();
});

watch([mode, stage, seqIndex], reset);

onUnmounted(() => cancelAnimationFrame(raf));
onMounted(load);
</script>

<template>
  <div class="stack">
    <div v-if="err" class="alert alert-danger">{{ err }}</div>

    <div v-if="loading" class="empty"><span class="spinner"></span></div>

    <div v-else-if="!fields.length && !stageSeq.length" class="card empty">
      <div class="empty-icon">🎯</div>
      <div class="empty-title">没有可回放的弹幕序列</div>
      <div class="empty-desc">
        ECL 弹幕序列在解包时从敌机行为脚本中提取。请先完成一次解包，或该作品的
        ECL 布局尚未被支持。
      </div>
    </div>

    <template v-else>
      <!-- 模式与关卡选择 -->
      <div class="card">
        <div class="row" style="gap: 10px; flex-wrap: wrap">
          <div class="field" style="margin: 0; min-width: 150px">
            <div class="field-label">回放模式</div>
            <select v-model="mode">
              <option value="field">关卡弹幕场（全关组合）</option>
              <option value="seq">单个行为脚本</option>
            </select>
          </div>
          <div class="field" style="margin: 0; min-width: 120px">
            <div class="field-label">关卡</div>
            <select v-model.number="stage">
              <option v-for="f in fields.length ? fields : stageSeq" :key="f.stage" :value="f.stage">
                {{ f.stage === 7 ? 'Extra' : `第 ${f.stage} 关` }}
                （{{ 'sequences' in f ? f.sequences.length : f.seqCount }} 段）
              </option>
            </select>
          </div>
          <div v-if="mode === 'seq'" class="field" style="margin: 0; flex: 1; min-width: 240px">
            <div class="field-label">行为脚本（按发射次数排序）</div>
            <select v-model.number="seqIndex" :disabled="!sequences.length">
              <option v-for="(s, i) in sequences" :key="s.subIndex" :value="i">
                子程序 #{{ s.subIndex }} · {{ s.eventCount }} 次发射 · {{ s.totalBullets }} 发弹 ·
                {{ s.durationSeconds }}s{{ s.spiral ? ' · 螺旋' : '' }}
              </option>
            </select>
          </div>
        </div>
      </div>

      <!-- 画布与控制 -->
      <div class="card">
        <div class="row" style="gap: 18px; align-items: flex-start; flex-wrap: wrap">
          <div>
            <canvas
              ref="canvasRef"
              :width="PLAY_W"
              :height="PLAY_H"
              style="border-radius: var(--radius); border: 1px solid var(--border); display: block; max-width: 100%"
            ></canvas>
            <div class="mute mono" style="font-size: 10px; margin-top: 5px; text-align: center">
              {{ PLAY_W }} × {{ PLAY_H }}（TH06 游戏区比例）
            </div>
          </div>

          <div class="stack" style="flex: 1; min-width: 260px; gap: 12px">
            <div class="row" style="gap: 8px">
              <button class="btn btn-primary btn-sm" style="width: 84px" @click="togglePlay">
                {{ playing ? '⏸ 暂停' : '▶ 播放' }}
              </button>
              <button class="btn btn-sm" @click="reset">↺ 重置</button>
              <select v-model.number="speed" style="width: 84px">
                <option :value="0.5">0.5×</option>
                <option :value="1">1×</option>
                <option :value="2">2×</option>
                <option :value="4">4×</option>
              </select>
            </div>

            <div>
              <input
                type="range"
                :min="0"
                :max="totalFrames"
                :value="frame"
                style="width: 100%"
                @input="seek(Number(($event.target as HTMLInputElement).value))"
              />
              <div class="row-between mono" style="font-size: 10.5px">
                <span>{{ (frame / 60).toFixed(2) }}s</span>
                <span class="mute">{{ (totalFrames / 60).toFixed(1) }}s</span>
              </div>
            </div>

            <!-- 统计 -->
            <div v-if="mode === 'field' && field" class="stat-grid" style="grid-template-columns: repeat(2, 1fr)">
              <div class="stat">
                <div class="stat-value">{{ field.seqCount }}</div>
                <div class="stat-label">敌方单位</div>
              </div>
              <div class="stat">
                <div class="stat-value">{{ field.sources.length }}</div>
                <div class="stat-label">发射位置</div>
              </div>
              <div class="stat">
                <div class="stat-value">{{ field.totalEvents }}</div>
                <div class="stat-label">发射次数</div>
              </div>
              <div class="stat">
                <div class="stat-value">{{ field.totalBullets }}</div>
                <div class="stat-label">总弹数</div>
              </div>
            </div>

            <div v-else-if="seq" class="stat-grid" style="grid-template-columns: repeat(2, 1fr)">
              <div class="stat">
                <div class="stat-value">{{ seq.eventCount }}</div>
                <div class="stat-label">发射次数</div>
              </div>
              <div class="stat">
                <div class="stat-value">{{ seq.totalBullets }}</div>
                <div class="stat-label">总弹数</div>
              </div>
              <div class="stat">
                <div class="stat-value">{{ seq.spiral ? '螺旋' : '直线' }}</div>
                <div class="stat-label">运动形态</div>
              </div>
              <div class="stat">
                <div class="stat-value">{{ seq.bulletTypes.length }}</div>
                <div class="stat-label">弹种数</div>
              </div>
            </div>

            <!-- 发射位置分布 -->
            <div v-if="mode === 'field' && origins.length">
              <div class="mute" style="font-size: 11px; margin-bottom: 5px">
                敌机发射位置（x 取自主时间线的真实生成坐标）
              </div>
              <div style="position: relative; height: 34px; background: var(--panel-2); border-radius: 5px">
                <div
                  v-for="(o, i) in origins"
                  :key="i"
                  style="position: absolute; width: 4px; height: 4px; background: var(--accent); border-radius: 50%; top: 15px"
                  :style="{ left: `calc(${(o.x / PLAY_W) * 100}% - 2px)` }"
                  :title="`敌机位置 (${o.x.toFixed(0)}, ${o.y})`"
                ></div>
              </div>
            </div>

            <!-- 发射时间轴 -->
            <div v-if="activeEvents.length" class="timeline">
              <div class="timeline-scale">
                <span style="left: 0">0s</span>
                <span style="left: 50%">
                  {{ ((mode === 'field' ? (field?.durationFrames ?? 0) : (seq?.durationFrames ?? 0)) / 120).toFixed(1) }}s
                </span>
                <span style="left: 100%">
                  {{ ((mode === 'field' ? (field?.durationFrames ?? 0) : (seq?.durationFrames ?? 0)) / 60).toFixed(1) }}s
                </span>
              </div>
              <div class="timeline-track" style="height: 30px">
                <div
                  v-for="(e, i) in activeEvents.slice(0, 160)"
                  :key="i"
                  class="timeline-node"
                  :style="{
                    left: `${((e.frame / Math.max(1, mode === 'field' ? (field?.durationFrames ?? 1) : (seq?.durationFrames ?? 1))) * 100).toFixed(2)}%`,
                  }"
                  :title="`子程序 #${e.subIndex} · ${(e.frame / 60).toFixed(2)}s · ${e.count} 发 · 速度 ${e.speed} · 角速度 ${e.spin}`"
                >
                  <span class="dot" :style="{ background: colorOf(e.bulletType) }"></span>
                  <span class="label">{{ e.count }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 边界说明 -->
      <div class="card">
        <div class="card-title">这份回放是怎么算出来的</div>
        <ul class="mute" style="font-size: 11.5px; line-height: 1.9; margin: 0; padding-left: 18px">
          <li>
            发射事件由 opcode <span class="mono">0x43</span> / <span class="mono">0x45</span> 的参数区还原，
            字段语义（弹数 / 速度 / 角度 / 角速度 / 弹种）经跨全部关卡 421 条样本的取值分布验证。
          </li>
          <li>
            <strong>横向位置是真实数据</strong> —— 每个发射源的 x 取自主时间线的敌机生成指令（f32），
            语义已由「x 落在屏幕内、y 在画面上方外侧」验证。纵向高度则是分层的近似值：
            生成点的 y 在画面外（-32），直接采用会看不到起手动作。
          </li>
          <li>
            各子程序的帧<strong>相对各自起点</strong>，弹幕场模式下按 24 帧间隔依次错开 ——
            全部叠在 0 帧会让所有弹幕同时炸开，既不真实也看不出结构。
          </li>
          <li>
            弹数 &gt; 1 时按<strong>整圆均分</strong>是渲染假设，实际展开取决于运行时状态，
            静态脚本无法确定。重力、加速、追踪、碰撞体形状均未建模。
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>
