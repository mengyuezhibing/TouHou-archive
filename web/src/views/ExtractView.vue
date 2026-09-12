<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  api,
  formatSize,
  type EntryDetail,
  type InspectResult,
  type InspectedEntry,
  type JobRecord,
} from '../api.ts';
import { store } from '../store.ts';

/**
 * 解包中心（对应 UI 设计文档第 6/7 节）。
 *
 * 采用三栏文件查看器布局：
 *   左栏 归档条目树 —— 不解包即可展开查看归档索引
 *   中栏 预览区     —— 图片直出；ANM / ECL / MSG 给出结构摘要
 *   右栏 属性面板   —— 条目元数据 + 解包操作
 */

const PRESETS = [
  { key: 'all', label: '全部解包', desc: '图片 / 精灵 / 图集 / 音频 / 文本 / 脚本' },
  { key: 'images', label: '仅图片', desc: 'ANM 精灵与图集' },
  { key: 'danmaku', label: '仅弹幕', desc: 'ECL 脚本与弹幕模式' },
  { key: 'audio', label: '仅音频', desc: 'BGM 与音效' },
  { key: 'text', label: '仅文本', desc: 'MSG 剧情文本' },
];

const GROUP_LABELS: Record<string, string> = {
  animation: '动画 ANM',
  script: '脚本 ECL',
  text: '文本 MSG',
  stage: '关卡 STD',
  image: '图片',
  audio: '音频',
  other: '其他',
};

const GROUP_ICONS: Record<string, string> = {
  animation: '◮',
  script: '✳',
  text: '¶',
  stage: '▤',
  image: '▦',
  audio: '♪',
  other: '◫',
};

/* ---------------- 归档选择 ---------------- */
const archives = ref<Array<{ id: number; file_name: string; file_path: string; size: number; entry_count: number; layout: string }>>([]);
const activeArchive = ref('');
const inspect = ref<InspectResult | null>(null);
const inspectLoading = ref(false);
const keyword = ref('');

const gameId = computed(() => store.currentGameId);
const currentGame = computed(() => store.currentGame);

/* ---------------- 选中条目 ---------------- */
const selected = ref<InspectedEntry | null>(null);
const detail = ref<EntryDetail | null>(null);
const detailLoading = ref(false);

/* ---------------- 解包任务 ---------------- */
const preset = ref('all');
const starting = ref(false);
const job = ref<JobRecord | null>(null);
const jobs = ref<JobRecord[]>([]);
const err = ref('');
let timer: number | undefined;

const grouped = computed(() => {
  const list = inspect.value?.entries ?? [];
  const filtered = keyword.value ? list.filter((e) => e.name.toLowerCase().includes(keyword.value.toLowerCase())) : list;
  const map = new Map<string, InspectedEntry[]>();
  for (const e of filtered) {
    const arr = map.get(e.group) ?? [];
    arr.push(e);
    map.set(e.group, arr);
  }
  const order = ['animation', 'script', 'text', 'stage', 'image', 'audio', 'other'];
  return order.filter((k) => map.has(k)).map((k) => [k, map.get(k)!] as [string, InspectedEntry[]]);
});

async function loadArchives() {
  if (!gameId.value) return;
  try {
    const res = await api.game(gameId.value);
    archives.value = res.archives.map((a: any) => ({ ...a, file_path: a.file_path }));
    if (archives.value.length && !archives.value.some((a) => a.file_path === activeArchive.value)) {
      activeArchive.value = archives.value[0].file_path;
    }
  } catch (e) {
    err.value = (e as Error).message;
  }
}

async function doInspect() {
  if (!activeArchive.value) return;
  inspectLoading.value = true;
  err.value = '';
  inspect.value = null;
  selected.value = null;
  detail.value = null;
  try {
    inspect.value = await api.inspectArchive(activeArchive.value, gameId.value || undefined);
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    inspectLoading.value = false;
  }
}

async function selectEntry(e: InspectedEntry) {
  selected.value = e;
  detail.value = null;
  detailLoading.value = true;
  try {
    detail.value = await api.inspectEntry(activeArchive.value, e.index, gameId.value || undefined);
  } catch (err2) {
    detail.value = null;
    err.value = (err2 as Error).message;
  } finally {
    detailLoading.value = false;
  }
}

const previewSrc = computed(() =>
  selected.value ? api.archivePreviewUrl(activeArchive.value, selected.value.index, gameId.value || undefined) : '',
);
const previewableImage = computed(() => !!detail.value?.isImage);

/* ---------------- 解包 ---------------- */

async function start() {
  if (!gameId.value) {
    err.value = '请先在顶部选择作品';
    return;
  }
  starting.value = true;
  err.value = '';
  try {
    const res = await api.extract(gameId.value, { files: [activeArchive.value], preset: preset.value });
    job.value = await api.job(res.jobId);
    startPolling();
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    starting.value = false;
  }
}

function startPolling() {
  stopPolling();
  timer = window.setInterval(async () => {
    if (!job.value) return;
    try {
      const updated = await api.job(job.value.id);
      job.value = updated;
      if (updated.status !== 'running') {
        stopPolling();
        await store.init(true);
        await loadArchives();
        await loadJobs();
      }
    } catch {
      stopPolling();
    }
  }, 600);
}

function stopPolling() {
  if (timer) {
    window.clearInterval(timer);
    timer = undefined;
  }
}

async function loadJobs() {
  try {
    jobs.value = (await api.jobs()).items;
  } catch {
    /* ignore */
  }
}

watch(activeArchive, doInspect);
watch(gameId, async () => {
  archives.value = [];
  activeArchive.value = '';
  inspect.value = null;
  selected.value = null;
  await loadArchives();
});

onMounted(async () => {
  await loadArchives();
  await loadJobs();
});
onUnmounted(stopPolling);
</script>

<template>
  <div class="stack">
    <div v-if="err" class="alert alert-danger">{{ err }}</div>

    <div v-if="!gameId" class="card empty">
      <div class="empty-icon">⧉</div>
      <div class="empty-title">未选择作品</div>
      <div class="empty-desc">请在顶部下拉框中选择一部作品，或先到「游戏库」扫描本地游戏目录。</div>
      <router-link to="/games" class="btn btn-primary">前往游戏库</router-link>
    </div>

    <template v-else>
      <!-- 归档选择 -->
      <div class="card" style="padding: 12px 16px">
        <div class="row-between">
          <div class="row" style="gap: 10px; flex-wrap: wrap">
            <span class="tag tag-accent mono">{{ currentGame?.id }}</span>
            <span style="font-size: 13.5px; font-weight: 650">{{ currentGame?.name }}</span>
            <span class="mute" style="font-size: 11.5px">资源包</span>
            <select v-model="activeArchive" style="width: 260px">
              <option v-for="a in archives" :key="a.id" :value="a.file_path">
                {{ a.file_name }} · {{ a.layout }} · {{ a.entry_count }} 条 · {{ formatSize(a.size) }}
              </option>
            </select>
          </div>
          <div class="row" style="gap: 6px">
            <button class="btn btn-sm" :disabled="inspectLoading" @click="doInspect">
              <span v-if="inspectLoading" class="spinner"></span>
              重新检视
            </button>
            <button class="btn btn-sm" @click="store.init(true).then(loadArchives)">刷新列表</button>
          </div>
        </div>
        <div v-if="inspect" class="mute" style="font-size: 11px; margin-top: 9px; line-height: 1.7">
          <span class="tag tag-blue mono">{{ inspect.layout }}</span>
          <span class="tag" :class="inspect.confidence > 0.7 ? 'tag-green' : 'tag-amber'" style="margin-left: 6px">
            置信度 {{ Math.round(inspect.confidence * 100) }}%
          </span>
          <span v-for="n in inspect.notes" :key="n" style="margin-left: 10px">· {{ n }}</span>
        </div>
      </div>

      <!-- 三栏文件查看器 -->
      <div class="three-pane">
        <!-- 左：资源树 -->
        <div class="card" style="padding: 11px; max-height: 62vh; overflow-y: auto">
          <div class="card-title" style="margin-bottom: 8px">
            文件树
            <span class="hint mono">{{ inspect?.entries.length ?? 0 }}</span>
          </div>
          <input v-model="keyword" placeholder="过滤条目…" style="margin-bottom: 9px; font-size: 12px" />

          <div v-if="inspectLoading" class="empty" style="padding: 20px"><span class="spinner"></span></div>
          <div v-else-if="!inspect" class="mute" style="font-size: 12px">选择一个资源包</div>
          <div v-else class="stack" style="gap: 11px">
            <div v-for="[group, list] in grouped" :key="group">
              <div class="nav-label" style="padding-left: 4px">
                {{ GROUP_ICONS[group] }} {{ GROUP_LABELS[group] ?? group }} · {{ list.length }}
              </div>
              <div class="stack" style="gap: 1px">
                <div
                  v-for="e in list"
                  :key="e.index"
                  class="nav-item"
                  :class="{ active: selected?.index === e.index }"
                  style="cursor: pointer; padding: 5px 8px"
                  @click="selectEntry(e)"
                >
                  <span style="flex: 1; min-width: 0">
                    <div class="mono" style="font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                      {{ e.displayName || e.name }}
                    </div>
                    <div class="mute mono" style="font-size: 9.5px">
                      {{ formatSize(e.zsize) }} → {{ formatSize(e.size) }}
                    </div>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 中：预览 -->
        <div class="card">
          <div class="card-title">
            预览
            <span class="hint mono">{{ selected?.name ?? '未选择条目' }}</span>
          </div>

          <div v-if="detailLoading" class="empty" style="padding: 50px"><span class="spinner"></span></div>

          <div v-else-if="!selected" class="empty" style="padding: 50px 16px">
            <div class="empty-icon">▦</div>
            <div class="empty-title">从左侧选择归档条目</div>
            <div class="empty-desc">无需解包即可浏览归档内容：图片直接预览，ANM / ECL / MSG 显示结构摘要。</div>
          </div>

          <template v-else>
            <div
              class="asset-thumb"
              style="border-radius: var(--radius); border: 1px solid var(--border-soft); min-height: 240px"
            >
              <img v-if="previewableImage" :src="previewSrc" alt="" style="max-height: 340px" />
              <div v-else-if="detail?.anm" style="text-align: center; padding: 20px">
                <img :src="previewSrc" alt="" style="max-height: 200px" @error="($event.target as HTMLImageElement).style.display = 'none'" />
                <div class="mute" style="font-size: 11.5px; margin-top: 8px">ANM 首个精灵预览</div>
              </div>
              <div v-else class="no-preview" style="text-align: center">
                <div style="font-size: 26px">{{ GROUP_ICONS[detail?.group ?? 'other'] }}</div>
                <div class="mute" style="font-size: 11.5px; margin-top: 6px">{{ detail?.magicLabel ?? '无图形预览' }}</div>
              </div>
            </div>

            <!-- 结构摘要 -->
            <div v-if="detail" class="stack" style="margin-top: 12px; gap: 8px">
              <div v-if="detail.anm" class="alert alert-info" style="font-size: 11.5px; line-height: 1.8">
                <strong>ANM 结构</strong>：{{ detail.anm.numSprites }} 个精灵 · {{ detail.anm.numScripts }} 条动画脚本<br />
                条目尺寸 {{ detail.anm.spriteEntrySize }}B · 像素格式 {{ detail.anm.pixelFormat }}<br />
                贴图构成：
                <span v-for="(c, k) in detail.anm.imageKinds" :key="k" class="mono" style="margin-right: 8px">{{ k }} {{ c }}</span>
              </div>

              <div v-if="detail.ecl" class="alert alert-info" style="font-size: 11.5px; line-height: 1.8">
                <strong>ECL 结构</strong>：{{ detail.ecl.subCount }} 个子程序 · {{ detail.ecl.totalInstructions }} 条指令<br />
                <span v-for="i in detail.ecl.inference" :key="i.kind">推断：{{ i.label }}　</span>
              </div>

              <div v-if="detail.msg" class="alert alert-info" style="font-size: 11.5px; line-height: 1.8">
                <strong>MSG 文本</strong>：{{ detail.msg.lines }} 行 · 布局 {{ detail.msg.layout }}
                <div v-for="(t, i) in detail.msg.sample" :key="i" class="mono" style="font-size: 11px; margin-top: 3px">{{ t }}</div>
              </div>

              <div>
                <div class="mute" style="font-size: 11px; margin-bottom: 4px">内容头部字节</div>
                <div class="mono" style="font-size: 10.5px; color: var(--text-dim); word-break: break-all; background: var(--bg-elevated); padding: 8px; border-radius: 6px">
                  {{ detail.hexPreview }}
                </div>
              </div>
            </div>
          </template>
        </div>

        <!-- 右：属性 + 解包操作 -->
        <div class="stack pane-inspector">
          <div class="card">
            <div class="card-title">属性</div>
            <div v-if="!detail" class="mute" style="font-size: 12px">未选择条目</div>
            <table v-else class="table" style="font-size: 11.5px">
              <tbody>
                <tr><td class="mute" style="width: 88px">条目名</td><td class="mono" style="word-break: break-all">{{ detail.name }}</td></tr>
                <tr><td class="mute">类型</td><td>{{ detail.magicLabel }}</td></tr>
                <tr><td class="mute">分组</td><td>{{ GROUP_LABELS[detail.group] ?? detail.group }}</td></tr>
                <tr><td class="mute">原始体积</td><td class="mono">{{ formatSize(detail.size) }}</td></tr>
                <tr><td class="mute">归档体积</td><td class="mono">{{ formatSize(detail.zsize) }}</td></tr>
                <tr><td class="mute">归档内偏移</td><td class="mono">0x{{ detail.offset.toString(16).toUpperCase() }}</td></tr>
                <tr v-if="detail.width"><td class="mute">尺寸</td><td class="mono">{{ detail.width }} × {{ detail.height }}</td></tr>
                <tr v-if="detail.imageFormat"><td class="mute">图像格式</td><td>{{ detail.imageFormat }}</td></tr>
              </tbody>
            </table>
          </div>

          <div class="card">
            <div class="card-title">解包操作</div>
            <div class="row" style="gap: 6px; flex-wrap: wrap; margin-bottom: 10px">
              <button
                v-for="p in PRESETS"
                :key="p.key"
                class="btn btn-xs"
                :class="{ 'btn-primary': preset === p.key }"
                @click="preset = p.key"
              >
                {{ p.label }}
              </button>
            </div>
            <div class="mute" style="font-size: 11px; margin-bottom: 10px">
              {{ PRESETS.find((p) => p.key === preset)?.desc }}
            </div>
            <button class="btn btn-primary" style="width: 100%" :disabled="starting || !activeArchive" @click="start">
              <span v-if="starting" class="spinner"></span>
              {{ starting ? '正在启动…' : '解包当前资源包' }}
            </button>

            <div v-if="job" style="margin-top: 12px">
              <div class="progress" style="margin-bottom: 8px">
                <div
                  class="progress-bar"
                  :style="{
                    width: `${job.progress}%`,
                    background: job.status === 'failed' ? 'var(--danger)' : job.status === 'done' ? 'var(--green)' : undefined,
                  }"
                ></div>
              </div>
              <div class="row-between" style="font-size: 11.5px">
                <span>{{ job.message }}</span>
                <span class="mono mute">{{ job.progress }}%</span>
              </div>
              <div v-if="job.status === 'done' && job.stats" class="stat-grid" style="grid-template-columns: repeat(2, 1fr); gap: 7px; margin-top: 10px">
                <div class="stat" style="padding: 8px 10px"><div class="stat-value" style="font-size: 16px">{{ job.stats.assets }}</div><div class="stat-label">素材</div></div>
                <div class="stat" style="padding: 8px 10px"><div class="stat-value" style="font-size: 16px">{{ job.stats.sprites }}</div><div class="stat-label">精灵</div></div>
                <div class="stat" style="padding: 8px 10px"><div class="stat-value" style="font-size: 16px">{{ job.stats.animations }}</div><div class="stat-label">动画</div></div>
                <div class="stat" style="padding: 8px 10px"><div class="stat-value" style="font-size: 16px">{{ job.stats.patternActions }}</div><div class="stat-label">弹幕动作</div></div>
              </div>
              <div v-if="job.status === 'failed'" class="alert alert-danger" style="margin-top: 9px; font-size: 11px">{{ job.error }}</div>
              <div v-if="job.status === 'done'" class="row" style="gap: 6px; margin-top: 10px">
                <router-link to="/assets" class="btn btn-xs btn-primary">浏览素材</router-link>
                <router-link to="/animation" class="btn btn-xs">动画</router-link>
              </div>
            </div>
          </div>

          <div v-if="jobs.length" class="card">
            <div class="card-title">最近任务</div>
            <div class="stack" style="gap: 5px">
              <div v-for="j in jobs.slice(0, 5)" :key="j.id" class="row-between" style="font-size: 11px">
                <span class="mono dim">{{ j.gameId }} · {{ j.kind }}</span>
                <span :class="j.status === 'done' ? 'tag tag-green' : j.status === 'failed' ? 'tag tag-accent' : 'tag tag-amber'">
                  {{ j.status === 'done' ? '完成' : j.status === 'failed' ? '失败' : '执行中' }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
