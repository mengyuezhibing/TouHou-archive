<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.ts';
import { store } from '../store.ts';

/**
 * 创作笔记（对应数据库文档第 17 节 Note 表 / UI 文档第 4 节导航项）。
 * 可为资源、作品、符卡、弹幕模式、Boss 挂载研究笔记。
 */

interface Note {
  id: string;
  target_type: string;
  target_id: string | null;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

const TARGETS = [
  { key: 'resource', label: '素材' },
  { key: 'game', label: '作品' },
  { key: 'spell', label: '符卡' },
  { key: 'pattern', label: '弹幕模式' },
  { key: 'boss', label: 'Boss' },
];

const notes = ref<Note[]>([]);
const loading = ref(false);
const err = ref('');
const filterType = ref('');
const keyword = ref('');

const editing = ref<Partial<Note> | null>(null);
const saving = ref(false);

const filtered = computed(() =>
  notes.value.filter((n) => {
    if (filterType.value && n.target_type !== filterType.value) return false;
    if (keyword.value && !n.title.includes(keyword.value) && !n.body.includes(keyword.value)) return false;
    return true;
  }),
);

async function load() {
  loading.value = true;
  err.value = '';
  try {
    const res = await api.notes();
    notes.value = res.items as unknown as Note[];
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

function createNew() {
  editing.value = {
    target_type: 'resource',
    target_id: store.currentGameId || '',
    title: '',
    body: '',
  };
}

function openEdit(n: Note) {
  editing.value = { ...n };
}

async function save() {
  const e = editing.value;
  if (!e?.title && !e?.body) return;
  saving.value = true;
  try {
    await api.saveNote({
      id: e.id,
      targetType: e.target_type ?? 'resource',
      targetId: e.target_id ?? '',
      title: e.title ?? '',
      body: e.body ?? '',
    });
    editing.value = null;
    await load();
  } catch (e2) {
    err.value = (e2 as Error).message;
  } finally {
    saving.value = false;
  }
}

async function remove(n: Note) {
  if (!confirm(`删除笔记「${n.title || '未命名'}」？`)) return;
  await api.deleteNote(n.id);
  if (editing.value?.id === n.id) editing.value = null;
  await load();
}

onMounted(load);
</script>

<template>
  <div class="stack">
    <div v-if="err" class="alert alert-danger">{{ err }}</div>

    <div class="toolbar">
      <button class="btn btn-primary btn-sm" @click="createNew">+ 新建笔记</button>
      <input v-model="keyword" placeholder="搜索笔记…" style="width: 220px" />
      <select v-model="filterType" style="width: 140px">
        <option value="">全部目标</option>
        <option v-for="t in TARGETS" :key="t.key" :value="t.key">{{ t.label }}</option>
      </select>
      <div class="topbar-spacer"></div>
      <span class="mute mono" style="font-size: 11.5px">{{ filtered.length }} 条</span>
    </div>

    <div v-if="loading" class="empty"><span class="spinner"></span></div>

    <div v-else-if="!notes.length" class="card empty">
      <div class="empty-icon">✎</div>
      <div class="empty-title">还没有研究笔记</div>
      <div class="empty-desc">
        笔记用于沉淀研究结论：某个 Boss 的弹幕压迫感来自哪里、某套立绘的配色规律、可复用的符卡结构等。
      </div>
      <button class="btn btn-primary" @click="createNew">写第一条笔记</button>
    </div>

    <div v-else class="grid" style="grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))">
      <div v-for="n in filtered" :key="n.id" class="card" style="cursor: pointer" @click="openEdit(n)">
        <div class="row-between" style="margin-bottom: 8px">
          <span class="tag tag-accent">{{ TARGETS.find((t) => t.key === n.target_type)?.label ?? n.target_type }}</span>
          <span class="mono mute" style="font-size: 10px">{{ (n.updated_at ?? '').slice(0, 10) }}</span>
        </div>
        <div style="font-size: 13.5px; font-weight: 650; margin-bottom: 5px">{{ n.title || '（未命名）' }}</div>
        <div class="dim" style="font-size: 11.5px; line-height: 1.7; white-space: pre-wrap; max-height: 76px; overflow: hidden">
          {{ n.body }}
        </div>
        <div v-if="n.target_id" class="mono mute" style="font-size: 10px; margin-top: 8px">目标：{{ n.target_id }}</div>
      </div>
    </div>

    <template v-if="editing">
      <div class="drawer-mask" @click="editing = null"></div>
      <div class="drawer" style="width: min(520px, 92vw)">
        <div class="drawer-head">
          <div style="flex: 1">
            <div style="font-size: 14px; font-weight: 650">{{ editing.id ? '编辑笔记' : '新建笔记' }}</div>
            <div class="mute" style="font-size: 11.5px">保存于本地 SQLite 的 Note 表</div>
          </div>
          <button class="btn btn-ghost btn-sm" @click="editing = null">✕</button>
        </div>

        <div class="drawer-body stack" style="gap: 12px">
          <div class="row" style="gap: 10px">
            <div class="field" style="flex: 1; margin: 0">
              <div class="field-label">目标类型</div>
              <select v-model="editing.target_type">
                <option v-for="t in TARGETS" :key="t.key" :value="t.key">{{ t.label }}</option>
              </select>
            </div>
            <div class="field" style="flex: 1.4; margin: 0">
              <div class="field-label">目标标识（可选）</div>
              <input v-model="editing.target_id" placeholder="如 TH06_BULLET_0001 / TH06" />
            </div>
          </div>
          <div class="field">
            <div class="field-label">标题</div>
            <input v-model="editing.title" placeholder="例如：蕾米莉亚符卡的压迫感来源" />
          </div>
          <div class="field">
            <div class="field-label">正文</div>
            <textarea v-model="editing.body" rows="12" placeholder="弹幕节奏、配色规律、可复用的结构、设计启示…"></textarea>
          </div>
        </div>

        <div class="drawer-foot">
          <button v-if="editing.id" class="btn btn-sm" @click="remove(editing as Note)">删除</button>
          <div style="flex: 1"></div>
          <button class="btn btn-sm" @click="editing = null">取消</button>
          <button class="btn btn-sm btn-primary" :disabled="saving" @click="save">保存</button>
        </div>
      </div>
    </template>
  </div>
</template>
