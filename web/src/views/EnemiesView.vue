<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.ts';
import { store } from '../store.ts';

/**
 * 怪物库（对应 UI 设计文档第 12 节「怪物研究页面」）。
 * 数据来自 Enemy 表，由解包阶段的名称关键词与角色归类自动建立。
 */

const items = ref<Array<Record<string, any>>>([]);
const loading = ref(false);
const err = ref('');
const keyword = ref('');
const current = ref<Record<string, any> | null>(null);

const TYPE_LABELS: Record<string, string> = {
  FAIRY: '妖精（杂兵）',
  YOUKAI: '妖怪',
  BOSS: 'Boss',
  EX_BOSS: 'EX Boss',
};

const TYPE_HINTS: Record<string, { behavior: string; usage: string }> = {
  FAIRY: { behavior: '直线移动 / 周期性散射弹', usage: '普通杂兵，用于建立弹幕密度节奏的基线' },
  YOUKAI: { behavior: '曲线移动 / 定向射击', usage: '中段敌人，可引入单点弹幕机制' },
  BOSS: { behavior: '多阶段 / 符卡循环', usage: '关卡 Boss，承担弹幕形态的主要演出' },
  EX_BOSS: { behavior: '高密度多形态切换', usage: 'EX 关底，用于测试技术上限与视觉冲击' },
};

const filtered = computed(() =>
  items.value.filter((e) => !keyword.value || e.name.includes(keyword.value) || (e.type ?? '').includes(keyword.value)),
);

const grouped = computed(() => {
  const map = new Map<string, Array<Record<string, any>>>();
  for (const e of filtered.value) {
    const key = e.type || 'OTHER';
    const list = map.get(key) ?? [];
    list.push(e);
    map.set(key, list);
  }
  return [...map.entries()];
});

const hint = computed(() => (current.value ? TYPE_HINTS[current.value.type] ?? null : null));

async function load() {
  loading.value = true;
  err.value = '';
  try {
    const res = await api.enemies(store.currentGameId || undefined);
    items.value = res.items;
    if (!current.value && res.items.length) current.value = res.items[0];
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    loading.value = false;
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
      <input v-model="keyword" placeholder="搜索怪物名 / 类型…" style="width: 240px" />
      <div class="topbar-spacer"></div>
      <span class="mute mono" style="font-size: 11.5px">{{ filtered.length }} 条记录</span>
    </div>

    <div v-if="loading" class="empty"><span class="spinner"></span></div>

    <div v-else-if="!items.length" class="card empty">
      <div class="empty-icon">👾</div>
      <div class="empty-title">尚未建立怪物索引</div>
      <div class="empty-desc">
        怪物记录在解包时按资源名（如 <span class="mono">enemy.anm</span>、<span class="mono">boss.anm</span>）与角色归类自动生成。
        请先在解包中心完成一次解包。
      </div>
      <router-link to="/extract" class="btn btn-primary">前往解包中心</router-link>
    </div>

    <div v-else style="display: grid; grid-template-columns: 260px 1fr; gap: 14px; align-items: start">
      <div class="card" style="padding: 12px; max-height: 70vh; overflow-y: auto">
        <div class="stack" style="gap: 12px">
          <div v-for="[type, list] in grouped" :key="type">
            <div class="nav-label" style="padding-left: 4px">{{ TYPE_LABELS[type] ?? type }} · {{ list.length }}</div>
            <div class="stack" style="gap: 2px">
              <div
                v-for="e in list"
                :key="e.id"
                class="nav-item"
                :class="{ active: current?.id === e.id }"
                style="cursor: pointer; padding: 7px 9px"
                @click="current = e"
              >
                <span style="flex: 1; min-width: 0">
                  <div style="font-size: 12.5px">{{ e.name }}</div>
                  <div class="mute mono" style="font-size: 10px">{{ e.meta?.sprites ?? 0 }} 精灵</div>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="current" class="stack">
        <div class="card">
          <div class="row-between">
            <div>
              <div style="font-size: 17px; font-weight: 700">{{ current.name }}</div>
              <div class="mute" style="font-size: 11.5px">{{ current.meta?.source ?? '—' }}</div>
            </div>
            <span class="tag tag-accent">{{ TYPE_LABELS[current.type] ?? current.type }}</span>
          </div>
        </div>

        <div class="stat-grid" style="grid-template-columns: repeat(3, 1fr)">
          <div class="stat"><div class="stat-value">{{ current.meta?.sprites ?? 0 }}</div><div class="stat-label">关联精灵</div></div>
          <div class="stat"><div class="stat-value">{{ current.hp || '—' }}</div><div class="stat-label">HP（待标注）</div></div>
          <div class="stat"><div class="stat-value">{{ current.speed || '—' }}</div><div class="stat-label">移动速度（待标注）</div></div>
        </div>

        <div v-if="hint" class="card">
          <div class="card-title">设计参考</div>
          <table class="table">
            <tbody>
              <tr><td class="mute" style="width: 110px">典型行为</td><td>{{ hint.behavior }}</td></tr>
              <tr><td class="mute">设计用途</td><td>{{ hint.usage }}</td></tr>
            </tbody>
          </table>
          <div class="alert alert-warn" style="margin-top: 12px; font-size: 11.5px; line-height: 1.7">
            HP / 移动 / 攻击模式等字段目前为空：这些数据存在于 ECL 与 STD 脚本中，
            当前版本已完成归档解压与弹幕动作提取，尚未把敌人属性反查回本表。
            可在下方字段就绪后手动标注，或等待后续版本接入 ECL 属性解析。
          </div>
        </div>

        <div class="card">
          <div class="card-title">属性标注</div>
          <div class="row" style="gap: 10px">
            <div class="field" style="flex: 1; margin: 0">
              <div class="field-label">HP</div>
              <input :value="current.hp || 0" type="number" disabled />
            </div>
            <div class="field" style="flex: 1; margin: 0">
              <div class="field-label">移动速度</div>
              <input :value="current.speed || 0" type="number" disabled />
            </div>
            <div class="field" style="flex: 2; margin: 0">
              <div class="field-label">攻击方式</div>
              <input :value="current.description || ''" placeholder="待接入 ECL 属性解析" disabled />
            </div>
          </div>
        </div>
      </div>

      <div v-else class="card empty">
        <div class="empty-icon">👾</div>
        <div class="empty-title">选择一条怪物记录</div>
      </div>
    </div>
  </div>
</template>
