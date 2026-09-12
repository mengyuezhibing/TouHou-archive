<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api, formatSize, CATEGORY_LABELS, previewUrl, type Asset, type AnimationRecord } from '../api.ts';
import { store } from '../store.ts';

/**
 * 动画分析器。
 * 动画与帧序列直接来自数据库的 Animation / Animation_Frame 表，
 * 帧内已携带对应精灵的可读编码，无需在前端重建映射。
 */

type AnimWithFrames = AnimationRecord & { frames: Array<{ frame_index: number; duration: number; image_code: string | null }> };

const anmList = ref<Asset[]>([]);
const total = ref(0);
const loading = ref(false);
const err = ref('');

const current = ref<Asset | null>(null);
const sprites = ref<Asset[]>([]);
const sheet = ref<Asset | null>(null);
const analysis = ref<any>(null);
const animations = ref<AnimationRecord[]>([]);
const currentAnim = ref<AnimWithFrames | null>(null);

const animIndex = ref(0);
const frameIndex = ref(0);
const playing = ref(false);
const speed = ref(1);
let playTimer: number | undefined;

const header = computed(() => analysis.value?.anm?.header ?? null);
const frames = computed(() => currentAnim.value?.frames ?? []);
const currentFrame = computed(() => frames.value[frameIndex.value] ?? null);
const currentSpriteCode = computed(() => currentFrame.value?.image_code ?? null);

async function loadList() {
  loading.value = true;
  err.value = '';
  try {
    const res = await api.assets({ gameId: store.currentGameId || undefined, kind: 'anm', limit: 200, sort: 'name' });
    anmList.value = res.items;
    total.value = res.total;
    if (!current.value && res.items.length) await select(res.items[0]);
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

/**
 * 退化模式。
 *
 * 部分版本（如 thcrap 汉化版）的 ANM 是**索引文件**：它不内嵌贴图，而是引用
 * 外部 PNG 路径（`data/face/face03a.png`）。这类 ANM 无法按原始 ZUN 结构解析，
 * 但被引用的贴图已经独立提取出来了。
 *
 * 因此在 Animation 表为空时，改为把**同基名的贴图**组织成序列，让查看器仍然可用。
 */
const isFallback = ref(false);

async function loadFallbackSequence(anm: Asset) {
  const base = anm.entry_name.replace(/\.[^.]+$/, '').replace(/_[ab]$/i, '');
  if (base.length < 3) return;

  const res = await api.assets({
    gameId: store.currentGameId || undefined,
    q: base,
    limit: 80,
    sort: 'name',
  });

  const lower = base.toLowerCase();
  // 只取真正的图片（排除 .anm 索引文件本身，它无法作为帧渲染）
  const imgs = res.items.filter(
    (x) =>
      x.kind === 'image' &&
      !x.entry_name.toLowerCase().endsWith('.anm') &&
      x.entry_name.toLowerCase().startsWith(lower) &&
      !!x.cache_path,
  );
  if (!imgs.length) return;

  isFallback.value = true;
  currentAnim.value = {
    id: -1,
    resource_id: 0,
    name: `${base} 贴图序列`,
    frame_count: imgs.length,
    fps: 4,
    loop: 1,
    meta: { fallback: true },
    frames: imgs.map((img, i) => ({
      id: -(i + 1),
      animation_id: -1,
      frame_index: i,
      duration: 10,
      image_id: 0,
      image_code: img.id,
      image_path: img.cache_path,
      x: 0,
      y: 0,
      rotation: 0,
      scale: 1,
    })),
  };
}

async function select(a: Asset) {
  stop();
  current.value = a;
  sprites.value = [];
  sheet.value = null;
  analysis.value = null;
  animations.value = [];
  currentAnim.value = null;
  animIndex.value = 0;
  frameIndex.value = 0;
  isFallback.value = false;
  try {
    const [sp, an, anims] = await Promise.all([api.anmSprites(a.id), api.analysis(a.id), api.animations(a.id)]);
    sprites.value = sp.items;
    sheet.value = sp.sheet ?? null;
    analysis.value = an;
    animations.value = anims.items;
    if (anims.items.length) {
      await loadAnimation(anims.items[0].id);
    } else {
      // Animation 表为空 —— 尝试用关联贴图构成序列
      await loadFallbackSequence(a);
    }
  } catch (e) {
    err.value = (e as Error).message;
  }
}

async function loadAnimation(id: number) {
  try {
    currentAnim.value = (await api.animation(id)) as AnimWithFrames;
    frameIndex.value = 0;
  } catch (e) {
    err.value = (e as Error).message;
  }
}

function tick() {
  const list = frames.value;
  if (!list.length) {
    stop();
    return;
  }
  frameIndex.value = (frameIndex.value + 1) % list.length;
  const dur = Math.max(1, list[frameIndex.value]?.duration ?? 6);
  playTimer = window.setTimeout(tick, Math.max(16, (dur * 1000) / 60 / speed.value));
}

function play() {
  if (!frames.value.length) return;
  playing.value = true;
  tick();
}

function stop() {
  playing.value = false;
  if (playTimer) {
    window.clearTimeout(playTimer);
    playTimer = undefined;
  }
}

function step(delta: number) {
  const len = frames.value.length;
  if (!len) return;
  frameIndex.value = (frameIndex.value + delta + len) % len;
}

watch(speed, () => {
  if (playing.value) {
    stop();
    play();
  }
});

watch(animIndex, async (i) => {
  const target = animations.value[i];
  if (target) await loadAnimation(target.id);
});

/** 点击精灵清单，跳到使用该精灵的第一帧 */
function jumpToSprite(code: string) {
  const idx = frames.value.findIndex((f) => f.image_code === code);
  if (idx >= 0) frameIndex.value = idx;
}

watch(
  () => store.currentGameId,
  () => {
    current.value = null;
    loadList();
  },
);

onMounted(loadList);
onUnmounted(stop);
</script>

<template>
  <div class="stack">
    <div v-if="err" class="alert alert-danger">{{ err }}</div>

    <div style="display: grid; grid-template-columns: 250px 1fr; gap: 14px; align-items: start">
      <!-- 动画包列表 -->
      <div class="card" style="padding: 12px; max-height: 74vh; overflow-y: auto">
        <div class="card-title" style="margin-bottom: 9px">
          ANM 动画包
          <span class="hint mono">{{ total }}</span>
        </div>
        <div v-if="loading" class="empty" style="padding: 20px"><span class="spinner"></span></div>
        <div v-else-if="!anmList.length" class="mute" style="font-size: 12px; padding: 10px 0">尚未提取到 ANM 资源，请先解包。</div>
        <div v-else class="stack" style="gap: 2px">
          <div
            v-for="a in anmList"
            :key="a.id"
            class="nav-item"
            :class="{ active: current?.id === a.id }"
            style="cursor: pointer; padding: 7px 9px"
            @click="select(a)"
          >
            <span style="flex: 1; min-width: 0">
              <div class="mono" style="font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                {{ a.entry_name }}
              </div>
              <div class="mute" style="font-size: 10px">
                {{ CATEGORY_LABELS[a.category] ?? a.category }} · {{ a.meta?.numSprites ?? 0 }} 精灵
              </div>
            </span>
          </div>
        </div>
      </div>

      <div v-if="!current" class="card empty">
        <div class="empty-icon">◮</div>
        <div class="empty-title">选择一个 ANM 动画包</div>
        <div class="empty-desc">左侧列出了已解包的动画资源。选中后可查看精灵清单、动画帧序列并预览播放。</div>
      </div>

      <div v-else class="stack">
        <!-- 头信息 -->
        <div class="card">
          <div class="row-between">
            <div>
              <div style="font-size: 14px; font-weight: 650" class="mono">{{ current.entry_name }}</div>
              <div class="mute" style="font-size: 11.5px">{{ current.id }} · {{ formatSize(current.size) }}</div>
            </div>
            <div class="row" style="gap: 5px">
              <span v-if="header" class="tag tag-blue mono">条目 {{ header.spriteEntrySize }}B</span>
              <span v-if="header" class="tag tag-purple mono">像素格式 {{ header.pixelFormat }}</span>
              <span v-if="anmList.length" class="tag tag-green mono">Animation 表 {{ animations.length }} 段</span>
              <span v-if="header" class="tag" :class="header.confidence > 0.7 ? 'tag-green' : 'tag-amber'">
                解析置信度 {{ Math.round((header.confidence ?? 0) * 100) }}%
              </span>
            </div>
          </div>
          <div v-if="header?.notes?.length" class="mute" style="font-size: 11px; margin-top: 9px; line-height: 1.7">
            <span v-for="n in header.notes" :key="n">· {{ n }}<br /></span>
          </div>
        </div>

        <!-- 播放器 -->
        <div class="card">
          <div class="card-title">
            动画预览
            <span class="hint">帧序列读取自 Animation_Frame 表，每帧已关联对应精灵资源</span>
          </div>

          <div class="row" style="align-items: stretch; gap: 16px; flex-wrap: wrap">
            <div
              class="asset-thumb"
              style="width: 200px; height: 200px; border-radius: var(--radius); border: 1px solid var(--border-soft); flex-shrink: 0"
            >
              <img v-if="currentSpriteCode" :src="previewUrl(currentSpriteCode)" style="max-height: 180px" alt="" />
              <span v-else class="no-preview">◮</span>
            </div>

            <div class="stack" style="flex: 1; min-width: 240px; gap: 10px">
              <div v-if="isFallback" class="alert alert-info" style="font-size: 11.5px; line-height: 1.7">
                该 ANM 是<b>索引文件</b>（重打包版本特征）：它不内嵌贴图，而是引用外部 PNG 路径，
                因此无法按原始 ZUN 结构还原帧序列。<br />
                下面使用<b>同基名的关联贴图</b>构成序列预览，帧序为文件名顺序，非原始动画脚本。
              </div>
              <div v-else-if="!animations.length" class="alert alert-warn" style="font-size: 11.5px">
                该动画包的脚本区未通过结构校验，且未找到可关联的贴图。精灵贴图仍可在素材浏览器中逐张查看。
              </div>
              <template v-if="frames.length">
                <div class="row" style="gap: 8px">
                  <button class="btn btn-primary btn-sm" style="min-width: 74px" @click="playing ? stop() : play()">
                    {{ playing ? '⏸ 暂停' : '▶ 播放' }}
                  </button>
                  <button class="btn btn-sm" @click="step(-1)">◀</button>
                  <button class="btn btn-sm" @click="step(1)">▶</button>
                  <select v-model.number="speed" style="width: 92px">
                    <option :value="0.25">0.25×</option>
                    <option :value="0.5">0.5×</option>
                    <option :value="1">1×</option>
                    <option :value="2">2×</option>
                    <option :value="4">4×</option>
                  </select>
                </div>

                <div v-if="animations.length">
                  <div class="field-label"><span>动画（Animation 表记录）</span><span class="val">{{ animations.length }} 段</span></div>
                  <select v-model.number="animIndex">
                    <option v-for="(s, i) in animations" :key="s.id" :value="i">
                      {{ s.name }} · {{ s.frame_count }} 帧 · {{ s.fps }}fps{{ s.loop ? ' · 循环' : '' }}
                    </option>
                  </select>
                </div>

                <div class="row-between" style="font-size: 11.5px">
                  <span class="dim">
                    当前帧 <span class="mono" style="color: var(--accent-2)">{{ frameIndex + 1 }}</span> /
                    <span class="mono">{{ frames.length }}</span>
                  </span>
                  <span class="mono mute">
                    → {{ currentSpriteCode ?? '（空帧）' }} · 时长 {{ currentFrame?.duration ?? '—' }} 帧
                  </span>
                </div>

                <div class="progress">
                  <div class="progress-bar" :style="{ width: `${((frameIndex + 1) / (frames.length || 1)) * 100}%` }"></div>
                </div>

                <!-- 帧条时间轴：按 Animation_Frame 顺序逐帧定位 -->
                <div>
                  <div class="mute" style="font-size: 10.5px; margin-bottom: 5px">帧序列（点击跳转）</div>
                  <div class="frame-strip">
                    <div
                      v-for="(f, i) in frames"
                      :key="f.id"
                      class="frame-cell"
                      :class="{ active: frameIndex === i }"
                      :title="`帧 ${i} · ${f.image_code ?? '空帧'} · 时长 ${f.duration}`"
                      @click="frameIndex = i"
                    >
                      {{ i }}
                    </div>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </div>

        <!-- 图集 -->
        <div v-if="sheet" class="card">
          <div class="card-title">
            Sprite Sheet 图集
            <span class="hint">TexturePacker JSON Hash，可直接导入 Unity / Godot</span>
          </div>
          <div class="row" style="gap: 14px; align-items: flex-start; flex-wrap: wrap">
            <div class="asset-thumb" style="border-radius: var(--radius); border: 1px solid var(--border-soft); max-width: 420px; padding: 8px">
              <img :src="previewUrl(sheet.id)" alt="" style="max-height: 220px" />
            </div>
            <div class="stack" style="gap: 6px; font-size: 11.5px">
              <div><span class="mute">尺寸</span> <span class="mono">{{ sheet.width }} × {{ sheet.height }}</span></div>
              <div><span class="mute">帧数</span> <span class="mono">{{ sheet.meta?.frameCount }}</span></div>
              <div><span class="mute">文件</span> <span class="mono">{{ sheet.meta?.jsonName }}</span></div>
              <a :href="`/api/assets/${sheet.id}/preview`" target="_blank" download class="btn btn-sm">下载图集 PNG</a>
              <a :href="`/api/assets/${current.id}/analysis`" target="_blank" class="btn btn-sm">查看动画 JSON</a>
            </div>
          </div>
        </div>

        <!-- 精灵清单 -->
        <div class="card">
          <div class="card-title">
            精灵清单
            <span class="hint">{{ sprites.length }} 张已导出，点击可跳到使用该精灵的帧</span>
          </div>
          <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(98px, 1fr)); gap: 8px">
            <div
              v-for="s in sprites"
              :key="s.id"
              class="asset-card"
              :style="currentSpriteCode === s.id ? { borderColor: 'var(--accent)', boxShadow: '0 0 12px rgba(233,69,96,0.3)' } : {}"
              @click="jumpToSprite(s.id)"
            >
              <div class="asset-thumb" style="aspect-ratio: 1.3">
                <img :src="previewUrl(s.id)" loading="lazy" alt="" />
              </div>
              <div class="asset-meta" style="padding: 5px 7px">
                <div class="mono" style="font-size: 10px">#{{ s.meta?.spriteId }}</div>
                <div class="mute mono" style="font-size: 9.5px">{{ s.width }}×{{ s.height }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
