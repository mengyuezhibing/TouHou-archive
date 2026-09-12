<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { api, formatSize, type Asset, type DanmakuParams, type Pattern, type PatternAction, type SimResult } from '../api.ts';
import EclReplay from '../components/EclReplay.vue';
import { store } from '../store.ts';

type Tab = 'analysis' | 'editor' | 'replay';

const tab = ref<Tab>('analysis');
const err = ref('');

// ---------------------------------------------------------------- ECL 分析

const eclList = ref<Asset[]>([]);
const eclLoading = ref(false);
const currentEcl = ref<Asset | null>(null);
const eclAnalysis = ref<any>(null);
const patterns = ref<Pattern[]>([]);
const expandedSub = ref<number | null>(0);

/** Bullet_Action 时间轴：由 ECL 指令流自动转换为数据库动作记录 */
const timelineActions = ref<PatternAction[]>([]);
const timelinePattern = ref<Pattern | null>(null);

function toggleSub(i: number) {
  expandedSub.value = expandedSub.value === i ? null : i;
}

/** 时间轴刻度：以最后一个动作的时间为右端（留 12% 余量） */
const timelineMax = computed(() => {
  const max = Math.max(0, ...timelineActions.value.map((a) => a.time));
  return max > 0 ? max * 1.12 : 1;
});

const timelineTicks = computed(() =>
  [0, 0.25, 0.5, 0.75, 1].map((f) => Number((timelineMax.value * f).toFixed(2))),
);

async function loadTimeline() {
  timelineActions.value = [];
  timelinePattern.value = null;
  const ecl = currentEcl.value;
  if (!ecl) return;
  const target = patterns.value.find((p) => p.source_asset === ecl.id);
  if (!target) return;
  timelinePattern.value = target;
  try {
    const detail = await api.patternDetail(target.id);
    timelineActions.value = detail.actions ?? [];
  } catch {
    /* 忽略：时间轴缺失不影响其余分析展示 */
  }
}

const TYPES = [
  { key: 'ring', label: '环形弹' },
  { key: 'fan', label: '扇形散弹' },
  { key: 'spiral', label: '旋转螺旋' },
  { key: 'random', label: '随机散射' },
  { key: 'aimed', label: '自机狙' },
  { key: 'laser', label: '激光列' },
  { key: 'wave', label: '波浪弹' },
  { key: 'homing', label: '追踪弹' },
];

/**
 * 子弹位移解析式（与后端 bulletPosition 一致）。
 * 三类运动学：直线 / 波浪（正弦垂直偏移）/ 追踪（恒定转向率圆弧）
 */
function bulletOffset(b: SimBullet, t: number): { x: number; y: number } {
  const rad = (b.angle * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const dist = b.speed * t + 0.5 * b.accel * t * t;

  if (b.waveMotion) {
    const d = Math.max(0, dist);
    const off = Math.sin(2 * Math.PI * b.waveMotion.frequency * t) * b.waveMotion.amplitude;
    return { x: dx * d - dy * off, y: dy * d + dx * off };
  }

  if (b.turnSpeed) {
    const omega = (b.turnSpeed * Math.PI) / 180;
    const th = omega * t;
    const R = b.speed / omega;
    const nx = -dy;
    const ny = dx;
    return {
      x: R * (Math.sin(th) * dx + (1 - Math.cos(th)) * nx),
      y: R * (Math.sin(th) * dy + (1 - Math.cos(th)) * ny),
    };
  }

  return { x: dx * dist, y: dy * dist };
}

function setType(key: string) {
  params.type = key as DanmakuParams['type'];
  void runSim();
}

async function loadEclList() {
  eclLoading.value = true;
  try {
    const res = await api.assets({ gameId: store.currentGameId || undefined, kind: 'ecl', limit: 100 });
    eclList.value = res.items;
    if (!currentEcl.value && res.items.length) await selectEcl(res.items[0]);
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    eclLoading.value = false;
  }
}

async function selectEcl(a: Asset) {
  currentEcl.value = a;
  eclAnalysis.value = null;
  try {
    const raw = await api.analysis(a.id);
    eclAnalysis.value = raw?.ecl ?? null;
  } catch (e) {
    eclAnalysis.value = { error: (e as Error).message };
  }
  await loadPatterns();
  await loadTimeline();
}

async function loadPatterns() {
  try {
    const res = await api.patterns(store.currentGameId || undefined);
    patterns.value = res.items;
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- 弹幕编辑器

const params = reactive<DanmakuParams>({
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
  turnSpeed: 45,
  frequency: 1.2,
  amplitude: 18,
  origin: { x: 0.5, y: 0.28 },
  seed: 20250811,
});

/* ---------------- 动作时间轴编辑（Bullet_Action） ---------------- */

interface EditAction {
  id?: number;
  time: number;
  action_type: string;
  count: number;
  speed: number;
  angle: number;
}

const ACTION_TYPES = ['spawn', 'rotate', 'accel', 'wait', 'laser', 'clear'];
const editActions = ref<EditAction[]>([]);
const timelineSaved = ref('');

function addAction() {
  const last = editActions.value[editActions.value.length - 1];
  editActions.value.push({
    time: Number(((last?.time ?? -1) + 1).toFixed(2)),
    action_type: 'spawn',
    count: params.count,
    speed: params.speed,
    angle: params.angle,
  });
}

function removeAction(i: number) {
  editActions.value.splice(i, 1);
}

/** 用当前编辑器参数追加一个动作 */
function appendCurrentParams() {
  const pos = editActions.value.length ? Math.max(...editActions.value.map((a) => a.time)) + 1 : 0;
  editActions.value.push({
    time: Number(pos.toFixed(2)),
    action_type: 'spawn',
    count: params.count,
    speed: params.speed,
    angle: params.angle,
  });
}

/** 载入某个弹幕模式的既有动作时间轴 */
async function loadActionsFrom(code: string) {
  try {
    const detail = await api.patternDetail(code);
    editActions.value = (detail.actions ?? []).map((a) => ({
      id: a.id,
      time: a.time,
      action_type: a.action_type,
      count: Number(a.parameter.count ?? 0),
      speed: Number(a.parameter.speed ?? 0),
      angle: Number(a.parameter.angle ?? 0),
    }));
    exportName.value = detail.name;
    timelineSaved.value = `已载入 ${editActions.value.length} 个动作`;
    window.setTimeout(() => (timelineSaved.value = ''), 2000);
  } catch (e) {
    err.value = (e as Error).message;
  }
}

/** 保存弹幕模式与其动作时间轴 */
async function saveWithActions() {
  try {
    const saved = await api.savePattern({
      gameId: store.currentGameId || undefined,
      name: exportName.value,
      type: params.type,
      params: { ...params },
      origin: 'designed',
      tags: ['弹幕编辑器'],
      note: `弹数 ${params.count} / 速度 ${params.speed} / 波数 ${params.waves} · ${editActions.value.length} 个动作`,
    });
    await api.savePatternActions(saved.id, editActions.value.map((a) => ({
      time: a.time,
      action_type: a.action_type,
      parameter: { count: a.count, speed: a.speed, angle: a.angle },
    })));
    await loadPatterns();
    timelineSaved.value = `已保存 ${editActions.value.length} 个动作到 Bullet_Action 表`;
    window.setTimeout(() => (timelineSaved.value = ''), 2600);
  } catch (e) {
    err.value = (e as Error).message;
  }
}

const sim = ref<SimResult | null>(null);
const simLoading = ref(false);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const playing = ref(true);
const frame = ref(0);
const exportName = ref('新建弹幕模式');
const exportResult = ref('');

let raf: number | undefined;
let lastTs = 0;

async function runSim() {
  simLoading.value = true;
  try {
    sim.value = await api.simulate({ ...params, origin: { ...params.origin } });
    frame.value = 0;
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    simLoading.value = false;
  }
}

function draw() {
  const canvas = canvasRef.value;
  const result = sim.value;
  if (!canvas || !result) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#0a0c13';
  ctx.fillRect(0, 0, W, H);

  // 网格
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (let y = 0; y <= H; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  const ox = result.params.origin.x * W;
  const oy = result.params.origin.y * H;

  // 自机位置
  ctx.fillStyle = 'rgba(233,69,96,0.18)';
  ctx.beginPath();
  ctx.arc(ox, oy, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e94560';
  ctx.beginPath();
  ctx.arc(ox, oy, 3, 0, Math.PI * 2);
  ctx.fill();

  const t = frame.value / 60;

  for (const b of result.bullets) {
    const age = t - b.spawnFrame / 60;
    if (age < 0) continue;
    const off = bulletOffset(b, age);
    const x = ox + off.x;
    const y = oy + off.y;
    if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;

    const hue = (b.angle * 1.6 + 350) % 360;
    ctx.fillStyle = `hsl(${hue}, 78%, 66%)`;
    ctx.beginPath();
    ctx.arc(x, y, 3.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `hsla(${hue}, 90%, 80%, 0.35)`;
    ctx.beginPath();
    ctx.arc(x, y, 6.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // HUD
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillText(`frame ${frame.value}`, 10, 18);
  ctx.fillText(`bullets ${result.bullets.filter((b) => b.spawnFrame <= frame.value).length}`, 10, 32);
}

function loop(ts: number) {
  if (!playing.value) return;
  raf = requestAnimationFrame(loop);
  const delta = lastTs ? ts - lastTs : 16;
  lastTs = ts;
  const total = sim.value?.totalFrames ?? 0;
  frame.value = (frame.value + Math.max(1, Math.round((delta / 16.67) * 1))) % Math.max(1, total + 90);
  draw();
}

function startLoop() {
  stopLoop();
  if (!playing.value) return;
  lastTs = 0;
  raf = requestAnimationFrame(loop);
}

function stopLoop() {
  if (raf) {
    cancelAnimationFrame(raf);
    raf = undefined;
  }
}

async function exportPattern(format: 'json' | 'godot') {
  try {
    const res = await api.exportDanmaku({ name: exportName.value, format, params: { ...params, origin: { ...params.origin } } });
    exportResult.value = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
    if (format === 'json') {
      const blob = new Blob([exportResult.value], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${exportName.value.replace(/\s+/g, '_')}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
  } catch (e) {
    err.value = (e as Error).message;
  }
}

async function saveAsPattern() {
  try {
    await api.savePattern({
      gameId: store.currentGameId || undefined,
      name: exportName.value,
      type: params.type,
      params: { ...params },
      origin: 'designed',
      tags: ['弹幕编辑器'],
      note: `弹数 ${params.count} / 速度 ${params.speed} / 波数 ${params.waves}`,
    });
    await loadPatterns();
  } catch (e) {
    err.value = (e as Error).message;
  }
}

async function deletePattern(id: string) {
  await api.deletePattern(id);
  await loadPatterns();
}

function applyInference(inf: any) {
  tab.value = 'editor';
  if (inf.kind === 'ring') {
    params.type = 'ring';
    params.count = Math.round(inf.avgCount) || 32;
    params.spread = 360;
    params.rotation = true;
  } else if (inf.kind === 'fan') {
    params.type = 'fan';
    params.count = Math.round(inf.avgCount) || 8;
    params.spread = Math.min(180, Math.max(20, inf.angleSpan)) || 60;
  } else if (inf.kind === 'spiral') {
    params.type = 'spiral';
    params.rotationPerWave = 15;
    params.rotation = true;
  } else if (inf.kind === 'dense') {
    params.type = 'ring';
    params.count = Math.max(48, Math.round(inf.avgCount));
    params.waves = 8;
  } else {
    params.type = 'fan';
    params.count = Math.round(inf.avgCount) || 5;
  }
  params.speed = Math.round(inf.avgSpeed * 60) || 90;
  runSim();
}

const maxCount = computed(() => {
  const h = eclAnalysis.value?.countHistogram ?? [];
  return Math.max(1, ...h.map((x: any) => x.count));
});

watch(playing, (v) => (v ? startLoop() : stopLoop()));

watch(
  () => store.currentGameId,
  () => {
    currentEcl.value = null;
    loadEclList();
    loadPatterns();
  },
);

onMounted(async () => {
  loadEclList();
  loadPatterns();
  await runSim();
  startLoop();
});

onUnmounted(stopLoop);
</script>

<template>
  <div class="stack">
    <div v-if="err" class="alert alert-danger">{{ err }}</div>

    <div class="toolbar">
      <button class="btn btn-sm" :class="{ 'btn-primary': tab === 'analysis' }" @click="tab = 'analysis'">
        ECL 参数分析
      </button>
      <button class="btn btn-sm" :class="{ 'btn-primary': tab === 'replay' }" @click="tab = 'replay'">
        ECL 回放
      </button>
      <button class="btn btn-sm" :class="{ 'btn-primary': tab === 'editor' }" @click="tab = 'editor'">
        弹幕编辑器
      </button>
      <div class="topbar-spacer"></div>
      <span class="mute" style="font-size: 11.5px">已归档弹幕模式 {{ patterns.length }} 个</span>
    </div>

    <!-- ================= ECL 分析 -->
    <div v-if="tab === 'analysis'" style="display: grid; grid-template-columns: 250px 1fr; gap: 14px; align-items: start">
      <div class="card" style="padding: 12px; max-height: 72vh; overflow-y: auto">
        <div class="card-title" style="margin-bottom: 9px">ECL 脚本</div>
        <div v-if="eclLoading" class="empty" style="padding: 20px"><span class="spinner"></span></div>
        <div v-else-if="!eclList.length" class="mute" style="font-size: 12px">
          未找到 ECL 资源。请在解包中心选择「仅弹幕」或「全部解包」。
        </div>
        <div v-else class="stack" style="gap: 2px">
          <div
            v-for="a in eclList"
            :key="a.id"
            class="nav-item"
            :class="{ active: currentEcl?.id === a.id }"
            style="cursor: pointer; padding: 7px 9px"
            @click="selectEcl(a)"
          >
            <span style="flex: 1; min-width: 0">
              <div class="mono" style="font-size: 11.5px">{{ a.entry_name }}</div>
              <div class="mute" style="font-size: 10px">{{ formatSize(a.size) }}</div>
            </span>
          </div>
        </div>
      </div>

      <div class="stack">
        <div v-if="!currentEcl" class="card empty">
          <div class="empty-icon">✳</div>
          <div class="empty-title">选择一份 ECL 脚本</div>
          <div class="empty-desc">
            ECL 是 ZUN 自研虚拟机的字节码。本工具通过结构解析 + 参数画像提取弹幕特征，并给出推断依据。
          </div>
        </div>

        <template v-else>
          <div class="card">
            <div class="row-between">
              <div>
                <div class="mono" style="font-size: 14px; font-weight: 650">{{ currentEcl.entry_name }}</div>
                <div class="mute" style="font-size: 11.5px">{{ currentEcl.id }}</div>
              </div>
              <div class="row" style="gap: 5px">
                <span v-if="eclAnalysis?.subCount !== undefined" class="tag tag-blue mono">子程序 {{ eclAnalysis.subCount }}</span>
                <span v-if="eclAnalysis?.totalInstructions !== undefined" class="tag tag-green mono">
                  指令 {{ eclAnalysis.totalInstructions }}
                </span>
                <span v-if="eclAnalysis?.mainOffset !== undefined" class="tag tag-purple mono">
                  主时间线 0x{{ eclAnalysis.mainOffset.toString(16).toUpperCase() }}
                </span>
                <span v-if="eclAnalysis?.confidence !== undefined" class="tag" :class="eclAnalysis.confidence > 0.6 ? 'tag-green' : 'tag-amber'">
                  解析置信度 {{ Math.round(eclAnalysis.confidence * 100) }}%
                </span>
              </div>
            </div>
            <div v-if="eclAnalysis?.notes?.length" class="mute" style="font-size: 11px; margin-top: 9px; line-height: 1.7">
              <span v-for="n in eclAnalysis.notes" :key="n">· {{ n }}<br /></span>
            </div>
          </div>

          <div v-if="eclAnalysis?.inference?.length" class="card">
            <div class="card-title">
              弹幕形态推断
              <span class="hint">基于提取到的速度 / 角度 / 弹数候选聚合得出</span>
            </div>
            <div class="stack" style="gap: 10px">
              <div
                v-for="inf in eclAnalysis.inference"
                :key="inf.kind"
                class="card"
                style="background: var(--panel-2); padding: 12px"
              >
                <div class="row-between">
                  <div class="row" style="gap: 8px">
                    <span class="tag tag-accent">{{ inf.label }}</span>
                    <span class="mono mute" style="font-size: 11px">样本 {{ inf.sampleCount }}</span>
                  </div>
                  <button class="btn btn-xs" @click="applyInference(inf)">载入编辑器 →</button>
                </div>
                <div style="font-size: 12px; margin-top: 7px; color: var(--text-dim)">{{ inf.evidence }}</div>
                <div class="row" style="gap: 16px; margin-top: 8px; font-size: 11.5px">
                  <span>平均速度 <span class="mono" style="color: var(--accent-2)">{{ inf.avgSpeed }}</span></span>
                  <span>平均弹数 <span class="mono" style="color: var(--accent-2)">{{ inf.avgCount }}</span></span>
                  <span>角度跨度 <span class="mono" style="color: var(--accent-2)">{{ inf.angleSpan }}°</span></span>
                </div>
              </div>
            </div>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px">
            <div class="card">
              <div class="card-title">速度分布 <span class="hint">单位/秒</span></div>
              <div v-if="!eclAnalysis?.speedHistogram?.length" class="mute" style="font-size: 12px">无候选</div>
              <div v-else class="stack" style="gap: 6px">
                <div v-for="h in eclAnalysis.speedHistogram.slice(0, 10)" :key="h.value">
                  <div class="row-between" style="font-size: 11px; margin-bottom: 2px">
                    <span class="mono">{{ h.value }}</span><span class="mono mute">{{ h.count }}</span>
                  </div>
                  <div class="progress">
                    <div class="progress-bar" :style="{ width: `${(h.count / eclAnalysis.speedHistogram[0].count) * 100}%` }"></div>
                  </div>
                </div>
              </div>
            </div>

            <div class="card">
              <div class="card-title">弹数分布</div>
              <div v-if="!eclAnalysis?.countHistogram?.length" class="mute" style="font-size: 12px">无候选</div>
              <div v-else class="stack" style="gap: 6px">
                <div v-for="h in eclAnalysis.countHistogram.slice(0, 10)" :key="h.value">
                  <div class="row-between" style="font-size: 11px; margin-bottom: 2px">
                    <span class="mono">{{ h.value }} 发</span><span class="mono mute">{{ h.count }}</span>
                  </div>
                  <div class="progress">
                    <div class="progress-bar" :style="{ width: `${(h.count / maxCount) * 100}%`, background: 'var(--blue)' }"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div v-if="timelineActions.length" class="card">
            <div class="card-title">
              动作时间轴
              <span class="hint">
                Bullet_Action 表 · {{ timelineActions.length }} 个动作 · 由 ECL 指令流自动转换
              </span>
            </div>
            <!-- 时间轴可视化（对应 UI 文档第 14 节 Timeline） -->
            <div class="timeline" style="margin-bottom: 12px">
              <div class="timeline-scale">
                <span v-for="(t, i) in timelineTicks" :key="i" :style="{ left: `${(i / (timelineTicks.length - 1)) * 100}%` }">
                  {{ t }}s
                </span>
              </div>
              <div class="timeline-track">
                <div
                  v-for="a in timelineActions"
                  :key="a.id"
                  class="timeline-node"
                  :class="`kind-${a.action_type}`"
                  :style="{ left: `${(a.time / timelineMax) * 100}%` }"
                  :title="`${a.action_type} @ ${a.time}s · 弹数 ${a.parameter.count ?? '—'}`"
                >
                  <span class="dot"></span>
                  <span class="label">{{ a.parameter.count ?? '' }}</span>
                </div>
              </div>
            </div>

            <div class="stack" style="gap: 5px">
              <div v-for="a in timelineActions" :key="a.id" class="row" style="gap: 9px; font-size: 11.5px; flex-wrap: wrap">
                <span class="tag tag-purple mono" style="min-width: 62px; justify-content: center">{{ a.time.toFixed(3) }}s</span>
                <span class="tag tag-blue">{{ a.action_type }}</span>
                <span class="mono mute">
                  弹数 {{ a.parameter.count }} · 速度 {{ a.parameter.speed }} · 角度 {{ a.parameter.angle }}
                  <template v-if="a.parameter.opcode">
                    · opcode 0x{{ a.parameter.opcode.toString(16).toUpperCase() }}
                  </template>
                  <template v-if="a.parameter.subroutine !== undefined"> · 子程序 #{{ a.parameter.subroutine }}</template>
                  <template v-if="a.parameter.confidence !== undefined">
                    · 置信 {{ (a.parameter.confidence * 100).toFixed(0) }}%
                  </template>
                </span>
              </div>
            </div>
            <div class="mute" style="font-size: 11px; margin-top: 9px">
              该时间轴已持久化为 Bullet_Action 记录，可供后续弹幕编辑器读取与二次编辑。
            </div>
          </div>

          <div v-if="eclAnalysis?.opcodeHistogram?.length" class="card">
            <div class="card-title">
              Opcode 分布
              <span class="hint">按指令头（frame/opcode/size）精确切分后统计，非字节级扫描</span>
            </div>
            <div class="stack" style="gap: 5px">
              <div v-for="h in eclAnalysis.opcodeHistogram.slice(0, 14)" :key="h.opcode">
                <div class="row-between" style="font-size: 11px; margin-bottom: 2px">
                  <span class="mono" style="color: var(--accent-2)">0x{{ h.opcode.toString(16).toUpperCase().padStart(4, '0') }}</span>
                  <span class="mono mute">{{ h.count }} 条指令</span>
                </div>
                <div class="progress">
                  <div
                    class="progress-bar"
                    :style="{ width: `${(h.count / eclAnalysis.opcodeHistogram[0].count) * 100}%`, background: 'var(--purple)' }"
                  ></div>
                </div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-title">
              子程序与指令流
              <span class="hint">共 {{ eclAnalysis?.totalInstructions ?? 0 }} 条指令，点击展开逐条查看</span>
            </div>
            <div class="stack" style="gap: 8px">
              <div
                v-for="s in (eclAnalysis?.subroutines ?? []).slice(0, 20)"
                :key="s.index"
                class="card"
                style="background: var(--panel-2); padding: 10px"
              >
                <div class="row-between" style="cursor: pointer" @click="toggleSub(s.index)">
                  <div class="row" style="gap: 7px; flex-wrap: wrap">
                    <span class="tag tag-blue mono">#{{ s.index }}</span>
                    <span class="mono mute" style="font-size: 11px">0x{{ s.offset.toString(16).toUpperCase() }}</span>
                    <span class="tag">{{ s.instructions.length }} 条指令</span>
                    <span class="tag" :class="s.terminated ? 'tag-green' : 'tag-amber'">
                      {{ s.terminated ? '正常终止' : '未见终止标记' }}
                    </span>
                    <span v-if="s.candidates.length" class="tag tag-accent">{{ s.candidates.length }} 个弹幕参数</span>
                  </div>
                  <span class="mute" style="font-size: 11.5px">{{ expandedSub === s.index ? '收起 ▲' : '展开 ▼' }}</span>
                </div>

                <div v-if="expandedSub === s.index" style="margin-top: 9px">
                  <table class="table" style="font-size: 11px">
                    <thead>
                      <tr><th>帧</th><th>opcode</th><th>size</th><th>rank</th><th>参数区</th></tr>
                    </thead>
                    <tbody>
                      <tr v-for="ins in s.instructions.slice(0, 60)" :key="ins.index">
                        <td class="mono">{{ ins.frame }}</td>
                        <td class="mono" style="color: var(--accent-2)">
                          0x{{ ins.opcode.toString(16).toUpperCase().padStart(4, '0') }}
                        </td>
                        <td class="mono">{{ ins.size }}</td>
                        <td class="mono mute">0x{{ ins.rankMask.toString(16) }}</td>
                        <td class="mono mute" style="word-break: break-all; max-width: 320px">{{ ins.paramHex || '—' }}</td>
                      </tr>
                    </tbody>
                  </table>
                  <div v-if="s.candidates.length" style="margin-top: 8px">
                    <div class="mute" style="font-size: 11px; margin-bottom: 4px">提取到的弹幕参数</div>
                    <div class="chips">
                      <span v-for="(c, ci) in s.candidates" :key="ci" class="tag tag-accent mono">
                        弹数 {{ c.count }} · 速度 {{ c.speed }} · 角度 {{ c.angle }} · 置信 {{ (c.confidence * 100).toFixed(0) }}%
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- ================= 编辑器 -->
    <div v-else-if="tab === 'editor'" style="display: grid; grid-template-columns: 340px 1fr; gap: 14px; align-items: start">
      <div class="card">
        <div class="card-title">弹幕参数</div>

        <div class="field">
          <div class="field-label"><span>弹幕类型</span></div>
          <div class="chips">
            <button
              v-for="t in TYPES"
              :key="t.key"
              class="btn btn-xs"
              :class="{ 'btn-primary': params.type === t.key }"
              @click="setType(t.key)"
            >
              {{ t.label }}
            </button>
          </div>
        </div>

        <div class="field">
          <div class="field-label"><span>每波弹数</span><span class="val">{{ params.count }}</span></div>
          <input v-model.number="params.count" type="range" min="1" max="128" @input="runSim" />
        </div>

        <div class="field">
          <div class="field-label"><span>速度（单位/秒）</span><span class="val">{{ params.speed }}</span></div>
          <input v-model.number="params.speed" type="range" min="10" max="320" @input="runSim" />
        </div>

        <div v-if="params.type !== 'ring'" class="field">
          <div class="field-label"><span>扇形张角（度）</span><span class="val">{{ params.spread }}</span></div>
          <input v-model.number="params.spread" type="range" min="5" max="360" @input="runSim" />
        </div>

        <div class="field">
          <div class="field-label"><span>中心角度（度）</span><span class="val">{{ params.angle }}</span></div>
          <input v-model.number="params.angle" type="range" min="0" max="360" @input="runSim" />
        </div>

        <div class="field">
          <div class="field-label"><span>波数</span><span class="val">{{ params.waves }}</span></div>
          <input v-model.number="params.waves" type="range" min="1" max="40" @input="runSim" />
        </div>

        <div class="field">
          <div class="field-label"><span>波间隔（帧）</span><span class="val">{{ params.waveInterval }}</span></div>
          <input v-model.number="params.waveInterval" type="range" min="2" max="180" @input="runSim" />
        </div>

        <div class="field">
          <div class="field-label"><span>每波旋转角（度）</span><span class="val">{{ params.rotationPerWave }}</span></div>
          <input v-model.number="params.rotationPerWave" type="range" min="-90" max="90" step="0.5" @input="runSim" />
        </div>

        <div class="field">
          <div class="field-label"><span>加速度</span><span class="val">{{ params.accel }}</span></div>
          <input v-model.number="params.accel" type="range" min="-120" max="120" @input="runSim" />
        </div>

        <div class="field">
          <div class="field-label"><span>角度抖动</span><span class="val">{{ params.jitter }}°</span></div>
          <input v-model.number="params.jitter" type="range" min="0" max="60" @input="runSim" />
        </div>

        <div class="field">
          <div class="field-label"><span>速度抖动</span><span class="val">{{ (params.speedJitter * 100).toFixed(0) }}%</span></div>
          <input v-model.number="params.speedJitter" type="range" min="0" max="1" step="0.05" @input="runSim" />
        </div>

        <!-- 波浪弹（正弦扰动） -->
        <template v-if="params.type === 'wave'">
          <div class="field">
            <div class="field-label"><span>波浪频率（Hz）</span><span class="val">{{ params.frequency }}</span></div>
            <input v-model.number="params.frequency" type="range" min="0.2" max="4" step="0.1" @input="runSim" />
          </div>
          <div class="field">
            <div class="field-label"><span>波浪振幅</span><span class="val">{{ params.amplitude }}</span></div>
            <input v-model.number="params.amplitude" type="range" min="0" max="60" @input="runSim" />
          </div>
        </template>

        <!-- 追踪弹（恒定转向率圆弧） -->
        <div v-if="params.type === 'homing'" class="field">
          <div class="field-label"><span>转向率（度/秒）</span><span class="val">{{ params.turnSpeed }}</span></div>
          <input v-model.number="params.turnSpeed" type="range" min="-180" max="180" step="5" @input="runSim" />
        </div>

        <label class="row" style="gap: 8px; font-size: 12px; margin-bottom: 12px">
          <input v-model="params.rotation" type="checkbox" style="width: auto" @change="runSim" />
          <span>逐波旋转</span>
        </label>

        <div class="field">
          <div class="field-label"><span>随机种子</span></div>
          <div class="row">
            <input v-model.number="params.seed" type="number" />
            <button class="btn btn-sm" @click="runSim">重算</button>
          </div>
        </div>

        <div class="field">
          <div class="field-label"><span>模式名称</span></div>
          <input v-model="exportName" />
        </div>

        <div class="row" style="gap: 6px; flex-wrap: wrap">
          <button class="btn btn-sm btn-primary" @click="saveAsPattern">保存到弹幕库</button>
          <button class="btn btn-sm" @click="exportPattern('json')">导出 JSON</button>
          <button class="btn btn-sm" @click="exportPattern('godot')">导出 Godot</button>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-title">
            实时预览
            <span class="hint">后端按参数生成发射时间表，前端逐帧积分渲染</span>
          </div>

          <div class="row" style="gap: 16px; align-items: flex-start; flex-wrap: wrap">
            <canvas
              ref="canvasRef"
              width="380"
              height="520"
              style="border-radius: var(--radius); border: 1px solid var(--border); background: #0a0c13; flex-shrink: 0"
            ></canvas>

            <div class="stack" style="gap: 10px; flex: 1; min-width: 200px">
              <div class="row" style="gap: 7px">
                <button class="btn btn-sm" @click="playing = !playing">{{ playing ? '⏸ 暂停' : '▶ 播放' }}</button>
                <button class="btn btn-sm" @click="frame = 0">⟲ 重置</button>
                <span v-if="simLoading" class="spinner"></span>
              </div>

              <div v-if="sim" class="stat-grid" style="grid-template-columns: 1fr 1fr; gap: 8px">
                <div class="stat" style="padding: 9px 11px">
                  <div class="stat-value" style="font-size: 17px">{{ sim.stats.bulletCount }}</div>
                  <div class="stat-label">子弹总数</div>
                </div>
                <div class="stat" style="padding: 9px 11px">
                  <div class="stat-value" style="font-size: 17px">{{ sim.stats.densityPerSecond }}</div>
                  <div class="stat-label">每秒弹量</div>
                </div>
                <div class="stat" style="padding: 9px 11px">
                  <div class="stat-value" style="font-size: 17px">{{ sim.stats.angleSpan }}°</div>
                  <div class="stat-label">角度跨度</div>
                </div>
                <div class="stat" style="padding: 9px 11px">
                  <div class="stat-value" style="font-size: 17px">{{ sim.stats.waves }}</div>
                  <div class="stat-label">波数</div>
                </div>
              </div>

              <div v-if="sim?.described" class="alert alert-info" style="font-size: 11.5px">
                形态判定：{{ sim.described.label }}
              </div>

              <div class="alert alert-warn" style="font-size: 11px; line-height: 1.7">
                参数为设计辅助用途，用于快速验证弹幕手感与视觉密度；本工具不生成可运行的游戏 Mod。
              </div>
            </div>
          </div>
        </div>

        <!-- 动作时间轴编辑 -->
        <div class="card">
          <div class="card-title">
            动作时间轴编辑
            <span class="hint">写入 Bullet_Action 表 · 可被引擎读取</span>
          </div>

          <div v-if="timelineSaved" class="alert alert-ok" style="margin-bottom: 10px; font-size: 11.5px">{{ timelineSaved }}</div>

          <!-- 时间轴可视化 -->
          <div v-if="editActions.length" class="timeline" style="margin-bottom: 10px">
            <div class="timeline-scale">
              <span
                v-for="(t, i) in [0, 0.25, 0.5, 0.75, 1]"
                :key="i"
                :style="{ left: `${t * 100}%` }"
              >
                {{ (Math.max(...editActions.map((a) => a.time), 1) * t).toFixed(1) }}s
              </span>
            </div>
            <div class="timeline-track">
              <div
                v-for="(a, i) in editActions"
                :key="i"
                class="timeline-node"
                :class="`kind-${a.action_type}`"
                :style="{ left: `${(a.time / Math.max(...editActions.map((x) => x.time), 1)) * 100}%` }"
                :title="`${a.action_type} @ ${a.time}s · 弹数 ${a.count}`"
              >
                <span class="dot"></span>
                <span class="label">{{ a.count }}</span>
              </div>
            </div>
          </div>

          <div v-if="!editActions.length" class="mute" style="font-size: 12px; margin-bottom: 10px">
            尚无动作。可用「追加当前参数」把编辑器里的参数固化为一个时间轴节点，或从弹幕库载入既有模式。
          </div>

          <div v-else class="stack" style="gap: 6px; max-height: 260px; overflow-y: auto">
            <div v-for="(a, i) in editActions" :key="i" class="row" style="gap: 6px; align-items: flex-end">
              <div class="field" style="margin: 0; width: 72px">
                <div class="field-label" style="font-size: 10px">时间(s)</div>
                <input v-model.number="a.time" type="number" step="0.1" style="padding: 4px 6px; font-size: 11.5px" />
              </div>
              <div class="field" style="margin: 0; width: 96px">
                <div class="field-label" style="font-size: 10px">动作</div>
                <select v-model="a.action_type" style="padding: 4px 6px; font-size: 11.5px">
                  <option v-for="t in ACTION_TYPES" :key="t" :value="t">{{ t }}</option>
                </select>
              </div>
              <div class="field" style="margin: 0; flex: 1">
                <div class="field-label" style="font-size: 10px">弹数 / 速度 / 角度</div>
                <div class="row" style="gap: 4px">
                  <input v-model.number="a.count" type="number" style="padding: 4px 6px; font-size: 11.5px" />
                  <input v-model.number="a.speed" type="number" style="padding: 4px 6px; font-size: 11.5px" />
                  <input v-model.number="a.angle" type="number" step="0.1" style="padding: 4px 6px; font-size: 11.5px" />
                </div>
              </div>
              <button class="btn btn-xs" @click="removeAction(i)">✕</button>
            </div>
          </div>

          <div class="row" style="gap: 6px; margin-top: 12px; flex-wrap: wrap">
            <button class="btn btn-sm" @click="appendCurrentParams">追加当前参数</button>
            <button class="btn btn-sm" @click="addAction">+ 空动作</button>
            <button v-if="editActions.length" class="btn btn-sm" @click="editActions = []">清空</button>
            <div style="flex: 1"></div>
            <button class="btn btn-sm btn-primary" @click="saveWithActions">保存模式 + 时间轴</button>
          </div>

          <div v-if="patterns.length" style="margin-top: 12px">
            <div class="mute" style="font-size: 11px; margin-bottom: 6px">从弹幕库载入既有时间轴</div>
            <div class="chips">
              <span
                v-for="p in patterns.filter((x) => x.action_count).slice(0, 8)"
                :key="p.id"
                class="tag tag-blue"
                style="cursor: pointer"
                @click="loadActionsFrom(p.id)"
              >
                {{ p.name.slice(0, 24) }} · {{ p.action_count }} 动作
              </span>
            </div>
          </div>
        </div>

        <!-- 弹幕库 -->
        <div class="card">
          <div class="card-title">
            弹幕模式库
            <span class="hint">来自 ECL 分析 + 编辑器保存</span>
          </div>
          <div v-if="!patterns.length" class="mute" style="font-size: 12px">暂无记录</div>
          <table v-else class="table">
            <thead>
              <tr><th>名称</th><th>类型</th><th>来源</th><th>参数</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="p in patterns.slice(0, 30)" :key="p.id">
                <td>{{ p.name }}</td>
                <td><span class="tag tag-blue">{{ p.type }}</span></td>
                <td class="mono mute" style="font-size: 11px">{{ p.origin }}</td>
                <td class="mono mute" style="font-size: 11px">
                  <span v-if="p.params.avgCount">弹数 {{ p.params.avgCount }}</span>
                  <span v-else-if="p.params.count">弹数 {{ p.params.count }}</span>
                  <span v-else>—</span>
                </td>
                <td>
                  <button class="btn btn-xs" @click="deletePattern(p.id)">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="exportResult" class="card">
          <div class="card-title">导出结果预览</div>
          <pre
            class="mono"
            style="
              background: var(--bg-elevated);
              padding: 12px;
              border-radius: 8px;
              font-size: 10.5px;
              max-height: 260px;
              overflow: auto;
              border: 1px solid var(--border-soft);
              margin: 0;
            "
            >{{ exportResult.slice(0, 4000) }}</pre
          >
        </div>
      </div>
    </div>

    <!-- ================= ECL 回放（作品里的真实弹幕） -->
    <EclReplay v-else />
  </div>
</template>
