<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api, fileUrl, type EnemyIntel, type EnemyWave } from '../api.ts';
import { store } from '../store.ts';

/**
 * 怪物库（UI 设计文档第 12 节）。
 *
 * 数据分三层来源，界面上也分别标注：
 *   1. 精灵预览 —— 敌机图集里的小尺寸贴图（通常就是杂兵本体）
 *   2. 波次属性 —— 从 ECL 主时间线解析的生成事件（时间 / 坐标 / 类型 / 分数）
 *   3. 行为特征 —— 从 ECL 子程序统计的角度与速度候选值
 *
 * 刻意不做的事：不给 HP 编造数值。TH06 的杂兵大多不由生成指令设定血量
 * （hp = -1，生死交给行为脚本），界面上如实显示这一点。
 */

const items = ref<EnemyIntel[]>([]);
const loading = ref(false);
const err = ref('');
const keyword = ref('');
const currentStage = ref<number | null>(null);
const zoom = ref<{ name: string; src: string } | null>(null);

const TYPE_LABELS: Record<string, string> = {
  FAIRY: '妖精（杂兵）',
  YOUKAI: '妖怪',
  BOSS: 'Boss',
  EX_BOSS: 'EX Boss',
};

const stageLabel = (s: number) => (s === 7 ? 'Extra' : `第 ${s} 关`);

/** 按关卡聚合：同一关可能有多个敌机图集（stg5enm / stg5enm2） */
const byStage = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  const map = new Map<number, EnemyIntel[]>();
  for (const e of items.value) {
    if (kw && !`${e.name} ${e.type}`.toLowerCase().includes(kw)) continue;
    const list = map.get(e.stage) ?? [];
    list.push(e);
    map.set(e.stage, list);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
});

const stages = computed(() => byStage.value.map(([stage, list]) => ({ stage, list })));

const current = computed(() => {
  const found = byStage.value.find(([s]) => s === currentStage.value);
  return found ? found[1] : (byStage.value[0]?.[1] ?? []);
});

const ecl = computed(() => current.value.find((e) => e.ecl)?.ecl ?? null);

/** 该关全部精灵（跨多个图集合并、按面积升序，小的优先） */
const sprites = computed(() =>
  current.value
    .flatMap((e) => e.sprites)
    .sort((a, b) => a.width * a.height - b.width * b.height)
    .slice(0, 60),
);

const toDeg = (rad: number) => `${((rad * 180) / Math.PI).toFixed(1)}°`;

/** 波次时间分布：把每波按时间放到 0-100% 的横轴上 */
const waveBars = computed(() => {
  const w = ecl.value?.waves ?? [];
  const max = Math.max(1, ...w.map((x) => x.time));
  return w.slice(0, 400).map((x) => ({ ...x, pct: (x.time / max) * 100 }));
});

/** 敌机类型 → 出现次数 / 横向范围，用于观察编队形态 */
const typeSummary = computed(() => {
  const w = ecl.value?.waves ?? [];
  const m = new Map<number, number[]>();
  for (const x of w) {
    const list = m.get(x.typeId) ?? [];
    list.push(x.x);
    m.set(x.typeId, list);
  }
  return [...m.entries()]
    .map(([typeId, xs]) => ({
      typeId,
      count: xs.length,
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
    }))
    .sort((a, b) => b.count - a.count);
});

async function load() {
  loading.value = true;
  err.value = '';
  const gameId = store.currentGameId;
  if (!gameId) {
    items.value = [];
    loading.value = false;
    return;
  }
  try {
    const res = await api.enemyIntel(gameId);
    items.value = res.items;
    if (currentStage.value === null && res.items.length) currentStage.value = res.items[0].stage;
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

watch(() => store.currentGameId, () => {
  currentStage.value = null;
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
      <span class="mute mono" style="font-size: 11.5px">
        {{ stages.length }} 个关卡 · {{ items.length }} 组敌机图集 · {{ sprites.length }} 张精灵
      </span>
    </div>

    <div v-if="loading" class="empty"><span class="spinner"></span></div>

    <div v-else-if="!items.length" class="card empty">
      <div class="empty-icon">👾</div>
      <div class="empty-title">尚未建立怪物索引</div>
      <div class="empty-desc">
        怪物记录在解包时按资源名（如 <span class="mono">stg1enm.anm</span>）与角色归类自动生成。
        请先在解包中心完成一次解包。
      </div>
      <router-link to="/extract" class="btn btn-primary">前往解包中心</router-link>
    </div>

    <div v-else style="display: grid; grid-template-columns: 190px 1fr; gap: 14px; align-items: start">
      <!-- 关卡导航 -->
      <div class="card" style="padding: 10px">
        <div class="nav-label" style="padding-left: 4px">关卡</div>
        <div class="stack" style="gap: 2px">
          <div
            v-for="s in stages"
            :key="s.stage"
            class="nav-item"
            :class="{ active: currentStage === s.stage }"
            style="cursor: pointer; padding: 7px 9px"
            @click="currentStage = s.stage"
          >
            <span style="flex: 1; min-width: 0">
              <div style="font-size: 12.5px">{{ stageLabel(s.stage) }}</div>
              <div class="mute mono" style="font-size: 10px">
                {{ s.list[0]?.ecl?.waveCount ?? 0 }} 波 · {{ s.list.length }} 组图集
              </div>
            </span>
          </div>
        </div>
      </div>

      <!-- 关卡详情 -->
      <div class="stack">
        <!-- 属性总览 -->
        <div class="card">
          <div class="row-between" style="margin-bottom: 12px">
            <div>
              <div style="font-size: 17px; font-weight: 700">{{ stageLabel(currentStage ?? 0) }} 敌方单位</div>
              <div class="mute" style="font-size: 11.5px">
                {{ ecl?.eclFile ?? '—' }} · {{ current.map((c) => c.name.replace(/^第 \d 关敌机（|）$/g, '')).join(' + ') }}
              </div>
            </div>
            <span class="tag tag-accent">{{ TYPE_LABELS[current[0]?.type ?? ''] ?? current[0]?.type ?? '—' }}</span>
          </div>

          <div v-if="ecl" class="stat-grid" style="grid-template-columns: repeat(5, 1fr)">
            <div class="stat">
              <div class="stat-value">{{ ecl.waveCount }}</div>
              <div class="stat-label">敌机波次</div>
            </div>
            <div class="stat">
              <div class="stat-value">{{ ecl.durationSeconds }}<span style="font-size: 12px">s</span></div>
              <div class="stat-label">道中时长</div>
            </div>
            <div class="stat">
              <div class="stat-value">{{ ecl.subCount }}</div>
              <div class="stat-label">行为脚本</div>
            </div>
            <div class="stat">
              <div class="stat-value">{{ ecl.typeIds.length }}</div>
              <div class="stat-label">敌机类型</div>
            </div>
            <div class="stat">
              <div class="stat-value">{{ (ecl.scoreTotal / 1000).toFixed(0) }}<span style="font-size: 12px">k</span></div>
              <div class="stat-label">理论总分</div>
            </div>
          </div>
        </div>

        <!-- 精灵预览 -->
        <div class="card">
          <div class="card-title">
            敌方单位外观
            <span class="hint">{{ sprites.length }} 张（按体积升序，小图多为杂兵本体；点击看大图）</span>
          </div>
          <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); gap: 6px">
            <div
              v-for="s in sprites"
              :key="s.code"
              class="asset-card"
              style="cursor: pointer"
              :title="`${s.name} (${s.width}×${s.height})`"
              @click="zoom = { name: s.name, src: fileUrl(s.path) }"
            >
              <div class="asset-thumb" style="aspect-ratio: 1; background: #1a1d14">
                <img :src="fileUrl(s.path)" loading="lazy" alt="" style="image-rendering: pixelated" />
              </div>
              <div class="asset-meta" style="padding: 3px 5px">
                <div class="mono" style="font-size: 9px; color: var(--text-mute)">{{ s.width }}×{{ s.height }}</div>
              </div>
            </div>
          </div>
        </div>

        <!-- 弹幕特征 -->
        <div v-if="ecl && (ecl.angleHints.length || ecl.speedHints.length)" class="card">
          <div class="card-title">
            弹幕特征
            <span class="hint">从行为脚本的参数中统计，非逐条指令语义解析</span>
          </div>
          <div class="stack" style="gap: 12px">
            <div v-if="ecl.angleHints.length">
              <div class="mute" style="font-size: 11px; margin-bottom: 6px">发射角度候选</div>
              <div class="chips">
                <span v-for="a in ecl.angleHints" :key="a" class="tag tag-blue mono">{{ toDeg(a) }}</span>
              </div>
            </div>
            <div v-if="ecl.speedHints.length">
              <div class="mute" style="font-size: 11px; margin-bottom: 6px">速度候选（像素/帧）</div>
              <div class="chips">
                <span v-for="s in ecl.speedHints" :key="s" class="tag tag-green mono">{{ s }}</span>
              </div>
            </div>
            <div v-if="typeSummary.length">
              <div class="mute" style="font-size: 11px; margin-bottom: 6px">编队形态（按敌机类型）</div>
              <table class="table" style="font-size: 11px">
                <thead>
                  <tr><th>类型编号</th><th>出现次数</th><th>横向范围</th><th style="width: 40%">分布</th></tr>
                </thead>
                <tbody>
                  <tr v-for="t in typeSummary.slice(0, 8)" :key="t.typeId">
                    <td class="mono">{{ t.typeId }}</td>
                    <td class="mono">{{ t.count }}</td>
                    <td class="mono mute">{{ t.minX }} ~ {{ t.maxX }}</td>
                    <td>
                      <div style="position: relative; height: 8px; background: var(--panel-2); border-radius: 4px">
                        <div
                          style="position: absolute; height: 100%; background: var(--sand); border-radius: 4px"
                          :style="{ left: `${(t.minX / 384) * 100}%`, right: `${Math.max(0, (1 - t.maxX / 384) * 100)}%` }"
                        ></div>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- 波次时间轴 -->
        <div v-if="ecl && ecl.waves.length" class="card">
          <div class="card-title">
            波次时间轴
            <span class="hint">前 {{ Math.min(400, ecl.waves.length) }} 波 · 横轴为出现时间</span>
          </div>
          <div style="position: relative; height: 60px; background: var(--panel-2); border-radius: 6px; overflow: hidden">
            <div
              v-for="w in waveBars"
              :key="w.index"
              style="position: absolute; width: 2px; height: 6px; background: var(--accent); border-radius: 1px"
              :style="{ left: `${w.pct}%`, top: `${((w.y + 64) / 512) * 100}%` }"
              :title="`${w.time}s · 类型 ${w.typeId} · (${w.x}, ${w.y}) · ${w.score} 分`"
            ></div>
          </div>
          <div class="row-between" style="font-size: 10px; color: var(--text-mute); margin-top: 4px">
            <span>0s</span><span>{{ (ecl.durationSeconds / 2).toFixed(0) }}s</span><span>{{ ecl.durationSeconds }}s</span>
          </div>
        </div>

        <!-- 解析边界说明 -->
        <div v-if="ecl" class="card">
          <div class="card-title">关于这些数据的边界</div>
          <ul class="mute" style="font-size: 11.5px; line-height: 1.9; margin: 0; padding-left: 18px">
            <li v-for="(w, i) in ecl.warnings" :key="i">{{ w }}</li>
            <li>
              敌机生成事件的参数布局由实际字节反推并做了语义校验（x 落在屏幕内、y 在画面上方外侧），
              但**其他作品的主时间线布局不同**，本页解析结果只对 TH06 有效。
            </li>
            <li>
              血量字段为 {{ ecl.explicitHpWaves }} / {{ ecl.waveCount }} 波设置了显式值；
              其余为 -1，表示生死由行为脚本控制 —— 这**不等于血量 1**，故不编造数值。
            </li>
          </ul>
        </div>
      </div>
    </div>

    <!-- 大图预览 -->
    <div v-if="zoom" class="drawer-backdrop" @click.self="zoom = null">
      <div class="card" style="max-width: 480px; padding: 18px">
        <div class="row-between" style="margin-bottom: 12px">
          <span class="mono" style="font-size: 12px">{{ zoom.name }}</span>
          <button class="btn btn-ghost btn-sm" @click="zoom = null">✕</button>
        </div>
        <div class="asset-thumb" style="background: #1a1d14; border-radius: var(--radius)">
          <img :src="zoom.src" alt="" style="image-rendering: pixelated; max-height: 380px" />
        </div>
      </div>
    </div>
  </div>
</template>
