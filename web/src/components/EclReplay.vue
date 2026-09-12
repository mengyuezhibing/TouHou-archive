<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api, type DanmakuSequence, type StageSequences } from '../api.ts';
import { store } from '../store.ts';

/**
 * ECL 弹幕回放：把行为脚本里还原出的发射事件逐帧演算出来。
 *
 * 与「参数化模拟」的区别：这里的数据来自作品本身，
 * 不是用户手调参数 —— 看到的是这一关实际是怎么打的。
 *
 * 渲染方式：每帧按事件生成子弹，再对所有子弹做一次位置积分。
 * 只有 60fps 的一份状态，不做全帧预计算（那样在 1000+ 发弹时会很占内存）。
 */

/** TH06 游戏区尺寸，按真实比例呈现 */
const PLAY_W = 384;
const PLAY_H = 448;
/** 场景缩放（画布逻辑坐标 → 屏幕坐标由 CSS 控制） */
const SCALE = 1;

const stages = ref<StageSequences[]>([]);
const stage = ref<number | null>(null);
const seqIndex = ref(0);
const loading = ref(false);
const err = ref('');

const playing = ref(false);
const speed = ref(1);
/** 当前播放帧 */
const frame = ref(0);
/** 播放总帧数 */
const totalFrames = ref(600);

const canvasRef = ref<HTMLCanvasElement | null>(null);
let raf = 0;
let bulletState: Array<{ x: number; y: number; angle: number; speed: number; spin: number; type: number }> = [];
let firedUpTo = -1;

const currentStage = computed(() => stages.value.find((s) => s.stage === stage.value) ?? null);
const sequences = computed(() => currentStage.value?.sequences ?? []);
const seq = computed<DanmakuSequence | null>(() => sequences.value[seqIndex.value] ?? null);

/** 弹药类型 → 颜色，用于区分不同弹种 */
const TYPE_COLORS = ['#e8c547', '#7da266', '#5f93b8', '#9a86bd', '#b8563f', '#5aa39b'];
const colorOf = (t: number) => TYPE_COLORS[Math.abs(t) % TYPE_COLORS.length];

async function load() {
  const gameId = store.currentGameId;
  if (!gameId) {
    stages.value = [];
    return;
  }
  loading.value = true;
  err.value = '';
  try {
    const res = await api.danmakuSequences(gameId);
    stages.value = res.stages;
    if (stages.value.length) {
      stage.value = stages.value[0].stage;
      seqIndex.value = 0;
    }
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

/** 序列切换时重置播放状态 */
function reset() {
  playing.value = false;
  frame.value = 0;
  bulletState = [];
  firedUpTo = -1;
  const s = seq.value;
  if (!s) return;
  // 播放时长 = 脚本时长 + 3 秒余量，让子弹有时间飞出去
  totalFrames.value = Math.max(180, Math.min(s.durationFrames + 180, 3600));
  draw();
}

/** 推进一帧：发射该帧的事件，再对所有子弹做一次积分 */
function step() {
  const s = seq.value;
  if (!s) return;

  const f = frame.value;

  // 1. 生成子弹：事件按「弹数均分整圆」展开
  for (const ev of s.events) {
    if (ev.frame !== f) continue;
    for (let i = 0; i < ev.count; i++) {
      const a = ev.angle + (i / ev.count) * Math.PI * 2;
      bulletState.push({
        x: PLAY_W / 2,
        y: PLAY_H * 0.35,
        angle: a,
        speed: ev.speed * SCALE,
        spin: ev.spin,
        type: ev.bulletType,
      });
    }
  }
  firedUpTo = f;

  // 2. 积分：先按角速度转向，再沿当前角度前进
  for (const b of bulletState) {
    b.angle += b.spin;
    b.x += Math.cos(b.angle) * b.speed;
    b.y += Math.sin(b.angle) * b.speed;
  }

  // 3. 出界剔除（留一些余量，避免边界处突然消失）
  const M = 40;
  bulletState = bulletState.filter((b) => b.x > -M && b.x < PLAY_W + M && b.y > -M && b.y < PLAY_H + M);
}

function draw() {
  const cv = canvasRef.value;
  if (!cv) return;
  const ctx = cv.getContext('2d');
  if (!ctx) return;

  ctx.fillStyle = '#0e100c';
  ctx.fillRect(0, 0, PLAY_W, PLAY_H);

  // 参考网格：每 48px 一格，便于判断位置
  ctx.strokeStyle = 'rgba(125,162,102,0.12)';
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

  // 子弹
  for (const b of bulletState) {
    ctx.fillStyle = colorOf(b.type);
    ctx.beginPath();
    ctx.arc(b.x, b.y, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // 发射源（敌机位置）
  ctx.fillStyle = 'rgba(184,144,42,0.9)';
  ctx.beginPath();
  ctx.arc(PLAY_W / 2, PLAY_H * 0.35, 4, 0, Math.PI * 2);
  ctx.fill();
}

function tick() {
  if (!playing.value) return;
  // speed 倍速：每帧按倍率推进（>1 时一帧内多次演算）
  const steps = speed.value >= 1 ? Math.round(speed.value) : 1;
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
  // 播完了就从头开始
  if (frame.value >= totalFrames.value) {
    reset();
  }
  playing.value = true;
  raf = requestAnimationFrame(tick);
}

/** 拖动进度条：从 0 快进到目标帧（保证子弹状态连续） */
function seek(target: number) {
  frame.value = 0;
  bulletState = [];
  firedUpTo = -1;
  draw();
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

watch([stage, seqIndex], reset);

onUnmounted(() => cancelAnimationFrame(raf));

// 数据与画布都就绪后再初始化，避免首个 draw() 拿不到 canvas
onMounted(load);
</script>

<template>
  <div class="stack">
    <div v-if="err" class="alert alert-danger">{{ err }}</div>

    <div v-if="loading" class="empty"><span class="spinner"></span></div>

    <div v-else-if="!stages.length" class="card empty">
      <div class="empty-icon">🎯</div>
      <div class="empty-title">没有可回放的弹幕序列</div>
      <div class="empty-desc">
        ECL 弹幕序列在解包时从敌机行为脚本中提取。请先完成一次解包，或该作品的
        ECL 布局尚未被支持。
      </div>
    </div>

    <template v-else>
      <!-- 选择器 -->
      <div class="card">
        <div class="row" style="gap: 10px; flex-wrap: wrap">
          <div class="field" style="margin: 0; min-width: 130px">
            <div class="field-label">关卡</div>
            <select v-model.number="stage">
              <option v-for="s in stages" :key="s.stage" :value="s.stage">
                {{ s.stage === 7 ? 'Extra' : `第 ${s.stage} 关` }}（{{ s.sequences.length }} 段）
              </option>
            </select>
          </div>
          <div class="field" style="margin: 0; flex: 1; min-width: 240px">
            <div class="field-label">弹幕序列（按发射次数排序）</div>
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
            <!-- 播放控制 -->
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

            <!-- 当前序列属性 -->
            <div v-if="seq" class="stat-grid" style="grid-template-columns: repeat(2, 1fr)">
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

            <div v-if="seq" class="chips">
              <span v-for="s in seq.speeds" :key="s" class="tag tag-green mono">{{ s }} px/帧</span>
              <span v-if="seq.spiral" class="tag tag-purple">含角速度</span>
            </div>

            <!-- 发射时间轴 -->
            <div v-if="seq && seq.events.length" class="timeline">
              <div class="timeline-scale">
                <span style="left: 0">0s</span>
                <span style="left: 50%">{{ (seq.durationSeconds / 2).toFixed(1) }}s</span>
                <span style="left: 100%">{{ seq.durationSeconds }}s</span>
              </div>
              <div class="timeline-track" style="height: 30px">
                <div
                  v-for="(e, i) in seq.events"
                  :key="i"
                  class="timeline-node"
                  :style="{ left: `${seq.durationFrames ? (e.frame / seq.durationFrames) * 100 : 0}%` }"
                  :title="`${e.time}s · ${e.count} 发 · 速度 ${e.speed} · 角速度 ${e.spin}`"
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
            字段语义（弹数 / 速度 / 角度 / 角速度 / 弹种）经**跨全部关卡 421 条样本的取值范围**验证。
          </li>
          <li>
            <strong>弹数 &gt; 1 时按整圆均分</strong>是渲染假设 —— ECL 里的实际展开方式
            还取决于运行时状态，这部分无法从静态脚本确定。
          </li>
          <li>
            子弹按初速度直线飞行，角速度非 0 时持续转向（即螺旋）。重力、加速、
            追踪、以及子弹的碰撞体形状均未建模。
          </li>
          <li>
            各子程序的帧是<strong>相对各自起点</strong>的，因此按子程序独立回放。
            「哪一段在第几秒被哪个敌机调用」需要主时间线的类型编号与子程序索引的对应表，
            这张表当前没有。
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>
