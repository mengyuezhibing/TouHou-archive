<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api, formatSize, previewUrl, type Asset, type Character } from '../api.ts';
import { store } from '../store.ts';

/**
 * 角色库（对应 UI 设计文档第 11 节「角色研究页面」）。
 * 左侧角色清单，右侧研究面板：素材、配色、动画、关联弹幕与符卡。
 */

const characters = ref<Character[]>([]);
const loading = ref(false);
const err = ref('');
const keyword = ref('');

const current = ref<Character | null>(null);
const assets = ref<Asset[]>([]);
const linked = ref(false);
const relatedPatterns = ref<Array<Record<string, any>>>([]);
const relatedSpells = ref<Array<Record<string, any>>>([]);
const detailLoading = ref(false);

const TYPE_LABELS: Record<string, string> = {
  PLAYER: '自机',
  ENEMY: '敌机',
  BOSS: 'Boss',
  EX_BOSS: 'EX Boss',
  OTHER: '其他',
};

const filtered = computed(() =>
  characters.value.filter((c) => !keyword.value || c.name.includes(keyword.value) || (c.source ?? '').includes(keyword.value)),
);

const grouped = computed(() => {
  const map = new Map<string, Character[]>();
  for (const c of filtered.value) {
    const key = c.type || 'OTHER';
    const list = map.get(key) ?? [];
    list.push(c);
    map.set(key, list);
  }
  return [...map.entries()];
});

async function load() {
  loading.value = true;
  err.value = '';
  try {
    const res = await api.characters(store.currentGameId || undefined);
    characters.value = res.items;
    if (!current.value && res.items.length) await select(res.items[0]);
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function select(c: Character) {
  current.value = c;
  assets.value = [];
  relatedPatterns.value = [];
  relatedSpells.value = [];
  detailLoading.value = true;
  try {
    const res = await api.character(String(c.id));
    assets.value = res.items;
    linked.value = (res as any).linked !== false;

    // 关联弹幕与符卡：按角色名匹配 Boss / 模式名称
    const [patterns, spells] = await Promise.all([
      api.patterns(store.currentGameId || undefined),
      api.spells(store.currentGameId || undefined),
    ]);
    const name = c.name.replace(/（待命名）|·.*$/g, '').trim();
    relatedPatterns.value = patterns.items.filter((p) => name && (p.name.includes(name) || c.source?.includes(p.source_asset)));
    relatedSpells.value = spells.items.filter((s) => name && (s.boss?.includes(name) || name.includes(s.boss ?? '\u0000')));
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    detailLoading.value = false;
  }
}

watch(() => store.currentGameId, () => {
  current.value = null;
  load();
});

onMounted(load);
</script>

<template>
  <div class="stack">
    <div v-if="err" class="alert alert-danger">{{ err }}</div>

    <div class="toolbar">
      <input v-model="keyword" placeholder="搜索角色名 / 来源…" style="width: 260px" />
      <div class="topbar-spacer"></div>
      <span class="mute mono" style="font-size: 11.5px">{{ filtered.length }} 个角色</span>
    </div>

    <div style="display: grid; grid-template-columns: 260px 1fr; gap: 14px; align-items: start">
      <!-- 角色清单 -->
      <div class="card" style="padding: 12px; max-height: 74vh; overflow-y: auto">
        <div v-if="loading" class="empty" style="padding: 20px"><span class="spinner"></span></div>
        <div v-else-if="!filtered.length" class="mute" style="font-size: 12px; padding: 8px 0">
          尚未自动归类出角色。解包动画资源后会自动建立角色索引。
        </div>
        <div v-else class="stack" style="gap: 12px">
          <div v-for="[type, list] in grouped" :key="type">
            <div class="nav-label" style="padding-left: 4px">
              {{ TYPE_LABELS[type] ?? type }} · {{ list.length }}
            </div>
            <div class="stack" style="gap: 2px">
              <div
                v-for="c in list"
                :key="String(c.id)"
                class="nav-item"
                :class="{ active: current?.id === c.id }"
                style="cursor: pointer; padding: 7px 9px"
                @click="select(c)"
              >
                <span style="flex: 1; min-width: 0">
                  <div style="font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ c.name }}</div>
                  <div class="mute mono" style="font-size: 10px">{{ c.sprite_count }} 精灵 · {{ c.animation_count }} 动画</div>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 研究面板 -->
      <div v-if="!current" class="card empty">
        <div class="empty-icon">👤</div>
        <div class="empty-title">选择一个角色</div>
        <div class="empty-desc">角色由解包时的名称关键词、尺寸特征与主色分析自动归类，可在素材浏览器中人工修正。</div>
      </div>

      <div v-else class="stack">
        <div class="card">
          <div class="row-between">
            <div>
              <div style="font-size: 17px; font-weight: 700">{{ current.name }}</div>
              <div class="mute" style="font-size: 11.5px">
                来源 {{ current.source || '—' }} · <span class="mono">{{ current.game_id }}</span>
              </div>
            </div>
            <div class="row" style="gap: 5px">
              <span class="tag tag-accent">{{ TYPE_LABELS[current.type] ?? current.type }}</span>
              <span class="tag tag-blue mono">{{ current.sprite_count }} 精灵</span>
              <span class="tag tag-purple mono">{{ current.animation_count }} 动画</span>
              <span v-if="linked" class="tag tag-green">Character_Asset 已关联</span>
            </div>
          </div>

          <div v-if="current.colors?.length" style="margin-top: 12px">
            <div class="mute" style="font-size: 11px; margin-bottom: 6px">主色分析</div>
            <div class="chips">
              <span v-for="c in current.colors" :key="c" class="tag tag-amber">{{ c }}</span>
            </div>
          </div>
        </div>

        <div class="stat-grid" style="grid-template-columns: repeat(4, 1fr)">
          <div class="stat"><div class="stat-value">{{ assets.length }}</div><div class="stat-label">关联素材</div></div>
          <div class="stat"><div class="stat-value">{{ relatedPatterns.length }}</div><div class="stat-label">关联弹幕</div></div>
          <div class="stat"><div class="stat-value">{{ relatedSpells.length }}</div><div class="stat-label">关联符卡</div></div>
          <div class="stat"><div class="stat-value">{{ current.animation_count }}</div><div class="stat-label">动画段数</div></div>
        </div>

        <div class="card">
          <div class="card-title">
            素材
            <span class="hint">来自 Character_Asset 关联表</span>
          </div>
          <div v-if="detailLoading" class="empty" style="padding: 24px"><span class="spinner"></span></div>
          <div v-else-if="!assets.length" class="mute" style="font-size: 12px">未找到关联素材</div>
          <div v-else class="grid asset-grid" style="grid-template-columns: repeat(auto-fill, minmax(106px, 1fr))">
            <div v-for="a in assets.slice(0, 48)" :key="a.id" class="asset-card">
              <div class="asset-thumb" style="aspect-ratio: 1.25">
                <img v-if="a.cache_path && (a.kind === 'image' || a.kind === 'anm')" :src="previewUrl(a.id, a.cache_path)" loading="lazy" alt="" />
                <span v-else class="no-preview">◫</span>
              </div>
              <div class="asset-meta" style="padding: 5px 7px">
                <div class="asset-name" style="font-size: 10px">{{ a.meta?.spriteId !== undefined ? `#${a.meta.spriteId}` : a.entry_name }}</div>
                <div class="mute mono" style="font-size: 9.5px">
                  {{ a.width && a.height ? `${a.width}×${a.height}` : formatSize(a.size) }}
                </div>
              </div>
            </div>
          </div>
          <router-link v-if="assets.length > 48" to="/assets" class="btn btn-sm" style="margin-top: 10px">
            在素材浏览器中查看全部 {{ assets.length }} 项 →
          </router-link>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px">
          <div class="card">
            <div class="card-title">关联弹幕</div>
            <div v-if="!relatedPatterns.length" class="mute" style="font-size: 12px">无匹配记录</div>
            <div v-else class="stack" style="gap: 7px">
              <div v-for="p in relatedPatterns.slice(0, 8)" :key="p.id" class="row-between" style="font-size: 11.5px">
                <span>{{ p.name }}</span>
                <span class="tag tag-blue">{{ p.type }}</span>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-title">关联符卡</div>
            <div v-if="!relatedSpells.length" class="mute" style="font-size: 12px">
              尚未建立关联。可在符卡库中为 Boss 字段填写该角色名。
            </div>
            <div v-else class="stack" style="gap: 7px">
              <div v-for="s in relatedSpells.slice(0, 8)" :key="s.id" class="row-between" style="font-size: 11.5px">
                <span>{{ s.name }}</span>
                <span class="tag">{{ s.difficulty }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
