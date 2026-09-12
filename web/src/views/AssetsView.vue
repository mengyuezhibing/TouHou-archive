<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { api, formatSize, CATEGORY_LABELS, ROLE_LABELS, previewUrl, fileUrl, isPlayableAudio, type Asset } from '../api.ts';
import { store } from '../store.ts';

const filters = reactive({
  q: '',
  category: '',
  role: '',
  kind: '',
  tag: '',
  sort: 'name',
});

const items = ref<Asset[]>([]);
const total = ref(0);
const loading = ref(false);
const err = ref('');
const categories = ref<Array<{ category: string; count: number }>>([]);
const tags = ref<Array<{ tag: string; count: number }>>([]);

const detail = ref<Asset | null>(null);
const detailTab = ref<'info' | 'tags' | 'analysis' | 'colors'>('info');
const analysis = ref<Record<string, any> | null>(null);
const colors = ref<any>(null);
const newTag = ref('');
const editName = ref('');
const editRole = ref('');
const saving = ref(false);

const LIMIT = 60;

const activeFilterCount = computed(() => [filters.q, filters.category, filters.role, filters.kind, filters.tag].filter(Boolean).length);

async function load(reset = true) {
  loading.value = true;
  err.value = '';
  try {
    const offset = reset ? 0 : items.value.length;
    const res = await api.assets({
      gameId: store.currentGameId || undefined,
      q: filters.q || undefined,
      category: filters.category || undefined,
      role: filters.role || undefined,
      kind: filters.kind || undefined,
      tag: filters.tag || undefined,
      sort: filters.sort,
      limit: LIMIT,
      offset,
    });
    total.value = res.total;
    items.value = reset ? res.items : [...items.value, ...res.items];
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function loadMeta() {
  try {
    const [c, t] = await Promise.all([api.categories(store.currentGameId || undefined), api.tags(store.currentGameId || undefined)]);
    categories.value = c.items;
    tags.value = t.items;
  } catch {
    /* ignore */
  }
}

function resetFilters() {
  filters.q = '';
  filters.category = '';
  filters.role = '';
  filters.kind = '';
  filters.tag = '';
  load();
}

async function openDetail(a: Asset) {
  detail.value = a;
  detailTab.value = 'info';
  analysis.value = null;
  colors.value = null;
  editName.value = a.display_name || a.entry_name;
  editRole.value = a.role;
}

async function loadAnalysis() {
  if (!detail.value) return;
  try {
    analysis.value = await api.analysis(detail.value.id);
  } catch (e) {
    analysis.value = { error: (e as Error).message };
  }
}

async function loadColors() {
  if (!detail.value) return;
  try {
    colors.value = await api.colors(detail.value.id);
  } catch (e) {
    colors.value = { error: (e as Error).message };
  }
}

function switchTab(key: string) {
  detailTab.value = key as typeof detailTab.value;
  if (key === 'analysis' && !analysis.value) loadAnalysis();
  if (key === 'colors' && !colors.value) loadColors();
}

/** 全库中尚未打在该素材上的常用标签 */
const unusedTags = computed(() => {
  const cur = detail.value?.tags ?? [];
  return tags.value.filter((t) => !cur.includes(t.tag)).slice(0, 30);
});

async function quickAddTag(tag: string) {
  if (!detail.value) return;
  const updated = await api.addTag(detail.value.id, tag);
  detail.value = updated;
  const idx = items.value.findIndex((x) => x.id === updated.id);
  if (idx >= 0) items.value[idx] = updated;
  await loadMeta();
}

async function saveInfo() {
  if (!detail.value) return;
  saving.value = true;
  try {
    const updated = await api.updateAsset(detail.value.id, { displayName: editName.value, role: editRole.value });
    detail.value = updated;
    const idx = items.value.findIndex((x) => x.id === updated.id);
    if (idx >= 0) items.value[idx] = updated;
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

async function addTag() {
  if (!detail.value || !newTag.value.trim()) return;
  const updated = await api.addTag(detail.value.id, newTag.value.trim());
  detail.value = updated;
  newTag.value = '';
  const idx = items.value.findIndex((x) => x.id === updated.id);
  if (idx >= 0) items.value[idx] = updated;
  loadMeta();
}

async function dropTag(tag: string) {
  if (!detail.value) return;
  const updated = await api.removeTag(detail.value.id, tag);
  detail.value = updated;
  const idx = items.value.findIndex((x) => x.id === updated.id);
  if (idx >= 0) items.value[idx] = updated;
  loadMeta();
}

function iconFor(a: Asset): string {
  if (a.kind === 'image' || a.kind === 'anm') return '▦';
  if (a.kind === 'audio' || a.kind === 'bgm') return '♪';
  if (a.kind === 'text' || a.kind === 'msg') return '¶';
  if (a.kind === 'ecl' || a.kind === 'std' || a.kind === 'script') return '✳';
  return '◫';
}

watch(
  () => [store.currentGameId],
  () => {
    loadMeta();
    load();
  },
);

watch(
  () => [filters.category, filters.role, filters.kind, filters.tag, filters.sort],
  () => load(),
);

let searchTimer: number | undefined;
watch(
  () => filters.q,
  () => {
    if (searchTimer) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => load(), 260);
  },
);

onMounted(() => {
  loadMeta();
  load();
});
</script>

<template>
  <div class="stack">
    <div v-if="err" class="alert alert-danger">{{ err }}</div>

    <div class="toolbar">
      <input v-model="filters.q" placeholder="搜索素材名 / ID…" style="width: 240px" />
      <select v-model="filters.category" style="width: 150px">
        <option value="">全部分类</option>
        <option v-for="c in categories" :key="c.category" :value="c.category">
          {{ CATEGORY_LABELS[c.category] ?? c.category }}（{{ c.count }}）
        </option>
      </select>
      <select v-model="filters.role" style="width: 130px">
        <option value="">全部用途</option>
        <option v-for="(label, key) in ROLE_LABELS" :key="key" :value="key">{{ label }}</option>
      </select>
      <select v-model="filters.sort" style="width: 130px">
        <option value="name">按 ID 排序</option>
        <option value="size">按体积排序</option>
        <option value="dimension">按尺寸排序</option>
        <option value="recent">按时间排序</option>
      </select>
      <select v-if="tags.length" v-model="filters.tag" style="width: 150px">
        <option value="">全部标签</option>
        <option v-for="t in tags" :key="t.tag" :value="t.tag">{{ t.tag }}（{{ t.count }}）</option>
      </select>
      <button v-if="activeFilterCount" class="btn btn-ghost btn-sm" @click="resetFilters">清除筛选</button>
      <div class="topbar-spacer"></div>
      <span class="mute mono" style="font-size: 11.5px">{{ total }} 项</span>
    </div>

    <div v-if="loading && !items.length" class="empty"><span class="spinner"></span></div>

    <div v-else-if="!items.length" class="card empty">
      <div class="empty-icon">▦</div>
      <div class="empty-title">没有匹配的素材</div>
      <div class="empty-desc">
        可能是尚未解包该作品，或当前筛选条件过窄。前往「解包中心」处理归档文件。
      </div>
      <router-link to="/extract" class="btn btn-primary">前往解包中心</router-link>
    </div>

    <template v-else>
      <div class="grid asset-grid">
        <div v-for="a in items" :key="a.id" class="asset-card" @click="openDetail(a)">
          <div class="asset-thumb">
            <img v-if="a.cache_path && (a.kind === 'image' || a.kind === 'anm')" :src="previewUrl(a.id)" loading="lazy" alt="" />
            <span v-else class="no-preview">{{ iconFor(a) }}</span>
          </div>
          <div class="asset-meta">
            <div class="asset-name" :title="a.display_name || a.entry_name">
              <span v-if="isPlayableAudio(a)" style="color: var(--accent-2); margin-right: 4px">♪</span>
              {{ a.display_name || a.entry_name }}
            </div>
            <div class="asset-sub">
              <span>{{ CATEGORY_LABELS[a.category] ?? a.category }}</span>
              <span class="mono">{{ a.width && a.height ? `${a.width}×${a.height}` : formatSize(a.size) }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="items.length < total" style="text-align: center; padding: 8px 0 24px">
        <button class="btn" :disabled="loading" @click="load(false)">
          <span v-if="loading" class="spinner"></span>
          加载更多（{{ items.length }} / {{ total }}）
        </button>
      </div>
    </template>

    <!-- 详情抽屉 -->
    <template v-if="detail">
      <div class="drawer-mask" @click="detail = null"></div>
      <div class="drawer">
        <div class="drawer-head">
          <div style="flex: 1; min-width: 0">
            <div class="mono" style="font-size: 12px; color: var(--accent-2)">{{ detail.id }}</div>
            <div style="font-size: 14px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
              {{ detail.display_name || detail.entry_name }}
            </div>
          </div>
          <button class="btn btn-ghost btn-sm" @click="detail = null">✕</button>
        </div>

        <div style="display: flex; gap: 2px; padding: 10px 20px 0; border-bottom: 1px solid var(--border-soft)">
          <button
            v-for="t in [
              { key: 'info', label: '信息' },
              { key: 'tags', label: '标签' },
              { key: 'colors', label: '配色' },
              { key: 'analysis', label: '解析数据' },
            ]"
            :key="t.key"
            class="btn btn-sm"
            :class="{ 'btn-primary': detailTab === t.key }"
            style="border-radius: 6px 6px 0 0"
            @click="switchTab(t.key)"
          >
            {{ t.label }}
          </button>
        </div>

        <div class="drawer-body">
          <!-- 预览：图片 -->
          <div
            v-if="detail.cache_path && (detail.kind === 'image' || detail.kind === 'anm')"
            class="asset-thumb"
            style="border-radius: var(--radius); margin-bottom: 16px; border: 1px solid var(--border-soft)"
          >
            <img :src="previewUrl(detail.id)" alt="" style="max-height: 260px" />
          </div>

          <!-- 预览：音频在线播放 -->
          <div
            v-else-if="isPlayableAudio(detail)"
            class="card"
            style="margin-bottom: 16px; background: var(--panel-2); padding: 14px"
          >
            <div class="card-title" style="margin-bottom: 10px">
              <span>♪ 音频预览</span>
              <span class="hint mono">{{ detail.ext }} · {{ formatSize(detail.size) }}</span>
            </div>
            <audio :src="fileUrl(detail.cache_path)" controls preload="metadata" style="width: 100%; height: 36px"></audio>
            <div class="mute" style="font-size: 11px; margin-top: 9px; line-height: 1.8">
              <template v-if="detail.meta?.audio">
                <span v-if="detail.meta.audio.sampleRate">{{ detail.meta.audio.sampleRate }} Hz</span>
                <span v-if="detail.meta.audio.channels">
                  · {{ detail.meta.audio.channels === 1 ? '单声道' : `${detail.meta.audio.channels} 声道` }}
                </span>
                <span v-if="detail.meta.audio.bitsPerSample"> · {{ detail.meta.audio.bitsPerSample }} bit</span>
                <span v-if="detail.meta.audio.durationSeconds"> · 时长 {{ detail.meta.audio.durationSeconds }}s</span>
                <br />
              </template>
              <span v-if="detail.meta?.loose">来源：游戏目录独立文件（原地引用，未复制到缓存）</span>
            </div>
          </div>

          <div v-if="detailTab === 'info'" class="stack" style="gap: 14px">
            <div class="field">
              <div class="field-label">显示名称</div>
              <div class="row">
                <input v-model="editName" />
                <button class="btn btn-sm" :disabled="saving" @click="saveInfo">保存</button>
              </div>
            </div>

            <div class="field">
              <div class="field-label">用途归类</div>
              <div class="row">
                <select v-model="editRole">
                  <option v-for="(label, key) in ROLE_LABELS" :key="key" :value="key">{{ label }}</option>
                </select>
                <button class="btn btn-sm" :disabled="saving" @click="saveInfo">应用</button>
              </div>
            </div>

            <div class="card" style="background: var(--panel-2); padding: 12px">
              <table class="table" style="font-size: 11.5px">
                <tbody>
                  <tr><td class="mute" style="width: 100px">原始条目</td><td class="mono">{{ detail.entry_name }}</td></tr>
                  <tr><td class="mute">类型</td><td>{{ detail.kind }} / {{ CATEGORY_LABELS[detail.category] ?? detail.category }}</td></tr>
                  <tr><td class="mute">尺寸</td><td class="mono">{{ detail.width && detail.height ? `${detail.width} × ${detail.height}` : '—' }}</td></tr>
                  <tr><td class="mute">体积</td><td class="mono">{{ formatSize(detail.size) }}</td></tr>
                  <tr><td class="mute">归档内偏移</td><td class="mono">0x{{ detail.entry_offset.toString(16).toUpperCase() }}</td></tr>
                  <tr v-if="detail.content_hash"><td class="mute">内容哈希</td><td class="mono" style="font-size: 10.5px">{{ detail.content_hash.slice(0, 20) }}…</td></tr>
                  <tr v-if="detail.meta?.spriteId !== undefined"><td class="mute">精灵 ID</td><td class="mono">{{ detail.meta.spriteId }}</td></tr>
                  <tr v-if="detail.meta?.sourceAnm"><td class="mute">来源 ANM</td><td class="mono">{{ detail.meta.sourceAnm }}</td></tr>
                  <tr v-if="detail.meta?.frameCount !== undefined"><td class="mute">图集帧数</td><td class="mono">{{ detail.meta.frameCount }}</td></tr>
                </tbody>
              </table>
            </div>

            <div>
              <div class="mute" style="font-size: 11px; margin-bottom: 5px">文件路径</div>
              <div class="mono" style="font-size: 10.5px; word-break: break-all; color: var(--text-dim)">
                {{ detail.cache_path ?? '（未导出到磁盘）' }}
              </div>
            </div>

            <a v-if="detail.cache_path" :href="`/api/assets/${detail.id}/preview`" target="_blank" class="btn btn-sm" download>
              下载原始文件
            </a>
          </div>

          <div v-else-if="detailTab === 'tags'" class="stack" style="gap: 12px">
            <div class="field">
              <div class="field-label">新增标签</div>
              <div class="row">
                <input v-model="newTag" placeholder="例如：红色 / 巫女 / 可用作参考" @keyup.enter="addTag" />
                <button class="btn btn-sm btn-primary" @click="addTag">添加</button>
              </div>
            </div>
            <div>
              <div class="mute" style="font-size: 11px; margin-bottom: 7px">当前标签（点击移除）</div>
              <div v-if="!detail.tags.length" class="mute" style="font-size: 12px">暂无标签</div>
              <div v-else class="chips">
                <span v-for="t in detail.tags" :key="t" class="tag tag-accent" style="cursor: pointer" @click="dropTag(t)">
                  {{ t }} ✕
                </span>
              </div>
            </div>
            <div v-if="unusedTags.length">
              <div class="mute" style="font-size: 11px; margin-bottom: 7px">全库常用标签</div>
              <div class="chips">
                <span v-for="t in unusedTags" :key="t.tag" class="tag" style="cursor: pointer" @click="quickAddTag(t.tag)">
                  + {{ t.tag }}
                </span>
              </div>
            </div>
          </div>

          <div v-else-if="detailTab === 'colors'" class="stack" style="gap: 12px">
            <div v-if="!colors" class="empty"><span class="spinner"></span></div>
            <div v-else-if="colors.error" class="alert alert-warn">{{ colors.error }}</div>
            <template v-else>
              <div class="row" style="gap: 12px">
                <div
                  :style="{
                    width: '56px',
                    height: '56px',
                    borderRadius: '10px',
                    background: colors.dominantHex,
                    border: '1px solid var(--border)',
                  }"
                ></div>
                <div>
                  <div style="font-size: 14px; font-weight: 600">主色：{{ colors.dominantName }}</div>
                  <div class="mono mute" style="font-size: 11.5px">{{ colors.dominantHex }}</div>
                </div>
              </div>
              <div>
                <div class="mute" style="font-size: 11px; margin-bottom: 7px">色板分布</div>
                <div class="stack" style="gap: 7px">
                  <div v-for="p in colors.palette" :key="p.hex">
                    <div class="row-between" style="font-size: 11.5px; margin-bottom: 3px">
                      <div class="row" style="gap: 7px">
                        <span :style="{ width: '12px', height: '12px', borderRadius: '3px', background: p.hex, display: 'inline-block' }"></span>
                        <span>{{ p.name }}</span>
                        <span class="mono mute">{{ p.hex }}</span>
                      </div>
                      <span class="mono mute">{{ Math.round(p.ratio * 100) }}%</span>
                    </div>
                    <div class="progress"><div class="progress-bar" :style="{ width: `${p.ratio * 100}%` }"></div></div>
                  </div>
                </div>
              </div>
            </template>
          </div>

          <div v-else class="stack" style="gap: 12px">
            <div v-if="!analysis" class="empty"><span class="spinner"></span></div>
            <div v-else-if="analysis.error" class="alert alert-warn">{{ analysis.error }}</div>
            <template v-else>
              <div v-for="(val, key) in analysis" :key="key">
                <div class="section-title" style="font-size: 12px">{{ String(key).toUpperCase() }} 解析结果</div>
                <pre
                  class="mono"
                  style="
                    background: var(--bg-elevated);
                    padding: 12px;
                    border-radius: 8px;
                    font-size: 10.5px;
                    overflow: auto;
                    max-height: 320px;
                    border: 1px solid var(--border-soft);
                    margin: 0;
                  "
                  >{{ JSON.stringify(val, null, 2) }}</pre
                >
              </div>
            </template>
          </div>
        </div>

        <div class="drawer-foot">
          <span class="mute mono" style="flex: 1; font-size: 11px">{{ detail.category }} · {{ formatSize(detail.size) }}</span>
          <button class="btn btn-sm" @click="detail = null">关闭</button>
        </div>
      </div>
    </template>
  </div>
</template>
