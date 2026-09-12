<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.ts';
import { store } from '../store.ts';

interface MsgRow {
  id: number;
  game_id: string;
  asset_id: string;
  time: number;
  text: string;
  encoding: string;
}

const rows = ref<MsgRow[]>([]);
const loading = ref(false);
const err = ref('');
const keyword = ref('');
const globalSearch = ref(false);
const limit = ref(300);

const SPELLISH = /[符札]|スペルカード/;

const spellLines = computed(() => rows.value.filter((r) => SPELLISH.test(r.text)));
const quotedLines = computed(() => rows.value.filter((r) => /[「『]/.test(r.text)));

async function load() {
  loading.value = true;
  err.value = '';
  try {
    const res = await api.msg({
      gameId: keyword.value && globalSearch.value ? undefined : store.currentGameId || undefined,
      q: keyword.value || undefined,
      limit: limit.value,
    });
    rows.value = res.items;
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

/** 关键词高亮：按匹配位置分段转义，避免 HTML 注入与正则特殊字符问题 */
function highlight(text: string): string {
  const k = keyword.value.trim();
  if (!k) return escapeHtml(text);
  const lower = text.toLowerCase();
  const lk = k.toLowerCase();
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const idx = lower.indexOf(lk, i);
    if (idx === -1) {
      out.push(escapeHtml(text.slice(i)));
      break;
    }
    out.push(escapeHtml(text.slice(i, idx)));
    out.push(`<mark class="hl">${escapeHtml(text.slice(idx, idx + k.length))}</mark>`);
    i = idx + k.length;
  }
  return out.join('');
}

let timer: number | undefined;
watch(keyword, () => {
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(load, 280);
});
watch(() => store.currentGameId, load);
watch(globalSearch, load);

onMounted(load);
</script>

<template>
  <div class="stack">
    <div v-if="err" class="alert alert-danger">{{ err }}</div>

    <div class="toolbar">
      <input v-model="keyword" placeholder="搜索对话 / 符卡名 / 关键词…" style="width: 300px" />
      <label class="row" style="gap: 6px; font-size: 12px">
        <input v-model="globalSearch" type="checkbox" style="width: auto" />
        <span>全库检索</span>
      </label>
      <select v-model.number="limit" style="width: 120px" @change="load">
        <option :value="200">200 行</option>
        <option :value="500">500 行</option>
        <option :value="2000">2000 行</option>
      </select>
      <div class="topbar-spacer"></div>
      <span class="mute mono" style="font-size: 11.5px">{{ rows.length }} 行</span>
    </div>

    <div class="stat-grid" style="grid-template-columns: repeat(3, 1fr)">
      <div class="stat">
        <div class="stat-value">{{ rows.length }}</div>
        <div class="stat-label">载入文本行</div>
      </div>
      <div class="stat">
        <div class="stat-value">{{ quotedLines.length }}</div>
        <div class="stat-label">含引号（可能的专有名词）</div>
      </div>
      <div class="stat">
        <div class="stat-value">{{ spellLines.length }}</div>
        <div class="stat-label">含「符 / 札」的文本行</div>
      </div>
    </div>

    <div v-if="loading" class="empty"><span class="spinner"></span></div>

    <div v-else-if="!rows.length" class="card empty">
      <div class="empty-icon">¶</div>
      <div class="empty-title">暂无文本数据</div>
      <div class="empty-desc">
        剧情文本来自归档中的 <span class="mono">msg*.dat</span> / <span class="mono">*.msg</span>。
        请在解包中心使用「仅文本」或「全部解包」模式。
      </div>
      <router-link to="/extract" class="btn btn-primary">前往解包中心</router-link>
    </div>

    <template v-else>
      <!-- 符卡线索 -->
      <div v-if="spellLines.length" class="card">
        <div class="card-title">
          符卡名线索
          <span class="hint">含「符 / 札」的文本行，可在符卡库中一键提取</span>
        </div>
        <div class="chips">
          <span v-for="l in spellLines.slice(0, 24)" :key="l.id" class="tag tag-accent">{{ l.text.slice(0, 40) }}</span>
        </div>
        <router-link to="/spells" class="btn btn-sm" style="margin-top: 10px">前往符卡数据库</router-link>
      </div>

      <div class="card">
        <table class="table">
          <thead>
            <tr>
              <th style="width: 60px">行号</th>
              <th style="width: 80px">时间</th>
              <th>文本</th>
              <th style="width: 90px">编码</th>
              <th style="width: 90px">作品</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.id">
              <td class="mono dim">#{{ r.id }}</td>
              <td class="mono dim">{{ r.time }}</td>
              <td style="font-size: 12.5px; line-height: 1.7">
                <span v-html="highlight(r.text)"></span>
              </td>
              <td><span class="tag">{{ r.encoding }}</span></td>
              <td class="mono mute">{{ r.game_id }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
