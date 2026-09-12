<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api, type Design } from '../api.ts';

type Kind = 'boss' | 'weapon' | 'meta';

const KINDS: Array<{ key: Kind; label: string; icon: string; desc: string }> = [
  { key: 'boss', label: 'Boss 设计器', icon: '☠', desc: '分阶段编排弹幕形态与节奏' },
  { key: 'weapon', label: '武器设计器', icon: '⚔', desc: '按等级编排武器成长曲线' },
  { key: 'meta', label: '局外成长', icon: '⛩', desc: '设计 Meta Upgrade 分支与经济' },
];

const kind = ref<Kind>('boss');
const list = ref<Design[]>([]);
const current = ref<Design | null>(null);
const loading = ref(false);
const saving = ref(false);
const err = ref('');
const msg = ref('');
const showJson = ref(false);

const PATTERN_TYPES = ['ring', 'fan', 'spiral', 'random', 'aimed', 'laser'];

const TEMPLATES: Record<Kind, () => Record<string, any>> = {
  boss: () => ({
    hp: 4000,
    description: '',
    phases: [
      { name: 'Phase 1', hp: 1500, patternType: 'ring', count: 24, speed: 90, duration: 30, note: '开场热身，低密度全方位环形弹' },
      { name: 'Phase 2', hp: 1500, patternType: 'spiral', count: 12, speed: 120, duration: 35, note: '旋转逼近，压缩走位空间' },
      { name: 'Phase 3', hp: 1000, patternType: 'fan', count: 48, speed: 150, duration: 40, note: '符卡领域：高密度扇形压制' },
    ],
  }),
  weapon: () => ({
    baseDesc: '基础射击形态',
    levels: [
      { level: 1, desc: '单方向射击' },
      { level: 5, desc: '双向射击' },
      { level: 10, desc: '命中后产生爆炸范围伤害' },
    ],
  }),
  meta: () => ({
    currency: '信仰点',
    branches: [
      { name: '灵力强化', maxLevel: 5, effect: '每级 +8% 伤害', cost: 120 },
      { name: '幸运提升', maxLevel: 5, effect: '每级 +5% 道具掉落', cost: 100 },
      { name: '符卡强化', maxLevel: 3, effect: '每级 +12% 符卡伤害', cost: 260 },
      { name: '武器突破', maxLevel: 4, effect: '每级解锁一个武器词条', cost: 320 },
    ],
  }),
};

async function loadList() {
  loading.value = true;
  try {
    const res = await api.designs(kind.value);
    list.value = res.items;
    if (current.value && !list.value.some((d) => d.id === current.value!.id)) current.value = null;
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

function createNew() {
  const tpl = TEMPLATES[kind.value]();
  current.value = {
    id: '',
    kind: kind.value,
    name: kind.value === 'boss' ? '新 Boss' : kind.value === 'weapon' ? '新武器' : '新成长树',
    data: tpl,
    created_at: '',
    updated_at: '',
  };
  msg.value = '';
}

async function open(d: Design) {
  current.value = JSON.parse(JSON.stringify(d));
  msg.value = '';
}

async function save() {
  if (!current.value) return;
  saving.value = true;
  err.value = '';
  try {
    const saved = await api.saveDesign({
      id: current.value.id || undefined,
      kind: current.value.kind,
      name: current.value.name,
      data: current.value.data,
    });
    current.value = saved;
    msg.value = '已保存到本地工程库';
    await loadList();
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

async function remove(d: Design) {
  if (!confirm(`删除工程「${d.name}」？`)) return;
  await api.deleteDesign(d.id);
  if (current.value?.id === d.id) current.value = null;
  await loadList();
}

// 列表项操作
function addRow() {
  if (!current.value) return;
  const d = current.value.data;
  if (kind.value === 'boss') d.phases.push({ name: `Phase ${d.phases.length + 1}`, hp: 1000, patternType: 'ring', count: 16, speed: 90, duration: 30, note: '' });
  else if (kind.value === 'weapon') d.levels.push({ level: (d.levels.at(-1)?.level ?? 0) + 1, desc: '' });
  else d.branches.push({ name: '', maxLevel: 5, effect: '', cost: 100 });
}

function removeRow(i: number) {
  if (!current.value) return;
  const d = current.value.data;
  if (kind.value === 'boss') d.phases.splice(i, 1);
  else if (kind.value === 'weapon') d.levels.splice(i, 1);
  else d.branches.splice(i, 1);
}

watch(kind, () => {
  current.value = null;
  loadList();
});

onMounted(loadList);
</script>

<template>
  <div class="stack">
    <div v-if="err" class="alert alert-danger">{{ err }}</div>
    <div v-if="msg" class="alert alert-ok">{{ msg }}</div>

    <div class="toolbar">
      <button
        v-for="k in KINDS"
        :key="k.key"
        class="btn btn-sm"
        :class="{ 'btn-primary': kind === k.key }"
        @click="kind = k.key"
      >
        {{ k.icon }} {{ k.label }}
      </button>
      <div class="topbar-spacer"></div>
      <button class="btn btn-sm btn-primary" @click="createNew">+ 新建工程</button>
    </div>

    <div class="alert alert-info" style="font-size: 11.5px">
      {{ KINDS.find((k) => k.key === kind)?.desc }} · 所有工程保存在本地数据库，可用于同人游戏前期策划。
    </div>

    <div style="display: grid; grid-template-columns: 240px 1fr; gap: 14px; align-items: start">
      <!-- 工程列表 -->
      <div class="card" style="padding: 12px">
        <div class="card-title" style="margin-bottom: 9px">
          工程库
          <span class="hint mono">{{ list.length }}</span>
        </div>
        <div v-if="loading" class="empty" style="padding: 20px"><span class="spinner"></span></div>
        <div v-else-if="!list.length" class="mute" style="font-size: 12px; padding: 8px 0">
          暂无工程，点击右上角新建。
        </div>
        <div v-else class="stack" style="gap: 2px">
          <div
            v-for="d in list"
            :key="d.id"
            class="nav-item"
            :class="{ active: current?.id === d.id }"
            style="cursor: pointer; padding: 7px 9px"
            @click="open(d)"
          >
            <span style="flex: 1; min-width: 0">
              <div style="font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ d.name }}</div>
              <div class="mute mono" style="font-size: 10px">
                {{ d.kind === 'boss' ? `${d.data.phases?.length ?? 0} 阶段` : d.kind === 'weapon' ? `${d.data.levels?.length ?? 0} 等级` : `${d.data.branches?.length ?? 0} 分支` }}
              </div>
            </span>
            <button class="btn btn-xs" @click.stop="remove(d)">✕</button>
          </div>
        </div>
      </div>

      <!-- 编辑器 -->
      <div v-if="!current" class="card empty">
        <div class="empty-icon">⚒</div>
        <div class="empty-title">选择或新建一个工程</div>
        <div class="empty-desc">
          设计工坊用于把研究结论转化为可执行的策划案：Boss 分阶段弹幕编排、武器成长曲线、局外成长经济模型。
        </div>
        <button class="btn btn-primary" @click="createNew">新建{{ KINDS.find((k) => k.key === kind)?.label }}</button>
      </div>

      <div v-else class="stack">
        <div class="card">
          <div class="row-between" style="margin-bottom: 12px">
            <div class="row" style="gap: 10px; flex: 1">
              <input v-model="current.name" style="max-width: 300px; font-size: 14px; font-weight: 600" />
              <span class="tag">{{ KINDS.find((k) => k.key === current!.kind)?.label }}</span>
            </div>
            <div class="row" style="gap: 6px">
              <button class="btn btn-sm" @click="showJson = !showJson">{{ showJson ? '隐藏' : '查看' }} JSON</button>
              <button class="btn btn-sm btn-primary" :disabled="saving" @click="save">保存</button>
            </div>
          </div>

          <!-- Boss 设计器 -->
          <template v-if="current.kind === 'boss'">
            <div class="row" style="gap: 10px; margin-bottom: 12px">
              <div class="field" style="flex: 1; margin: 0">
                <div class="field-label">整体血量</div>
                <input v-model.number="current.data.hp" type="number" />
              </div>
              <div class="field" style="flex: 2; margin: 0">
                <div class="field-label">设计描述</div>
                <input v-model="current.data.description" placeholder="角色定位、视觉主题、与作品整体难度的关系" />
              </div>
            </div>

            <div class="card-title">
              阶段编排
              <span class="hint">{{ current.data.phases.length }} 个阶段</span>
            </div>
            <div class="stack" style="gap: 10px">
              <div v-for="(p, i) in current.data.phases" :key="i" class="card" style="background: var(--panel-2); padding: 12px">
                <div class="row-between" style="margin-bottom: 9px">
                  <div class="row" style="gap: 8px; flex: 1">
                    <span class="tag tag-accent mono">{{ i + 1 }}</span>
                    <input v-model="p.name" style="max-width: 180px" />
                  </div>
                  <button class="btn btn-xs" @click="removeRow(i)">删除阶段</button>
                </div>
                <div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 9px">
                  <div class="field" style="margin: 0">
                    <div class="field-label">血量</div>
                    <input v-model.number="p.hp" type="number" />
                  </div>
                  <div class="field" style="margin: 0">
                    <div class="field-label">弹幕类型</div>
                    <select v-model="p.patternType">
                      <option v-for="t in PATTERN_TYPES" :key="t" :value="t">{{ t }}</option>
                    </select>
                  </div>
                  <div class="field" style="margin: 0">
                    <div class="field-label">弹数</div>
                    <input v-model.number="p.count" type="number" />
                  </div>
                  <div class="field" style="margin: 0">
                    <div class="field-label">速度</div>
                    <input v-model.number="p.speed" type="number" />
                  </div>
                  <div class="field" style="margin: 0">
                    <div class="field-label">持续（秒）</div>
                    <input v-model.number="p.duration" type="number" />
                  </div>
                </div>
                <div class="field" style="margin: 9px 0 0">
                  <div class="field-label">阶段说明</div>
                  <input v-model="p.note" placeholder="节奏意图、走位要求、与前一阶段的差异" />
                </div>
              </div>
            </div>
            <button class="btn btn-sm" style="margin-top: 10px" @click="addRow">+ 添加阶段</button>
          </template>

          <!-- 武器设计器 -->
          <template v-else-if="current.kind === 'weapon'">
            <div class="field">
              <div class="field-label">基础描述</div>
              <input v-model="current.data.baseDesc" placeholder="武器定位、攻击方式、与自机的关系" />
            </div>

            <div class="card-title">等级成长</div>
            <div class="stack" style="gap: 8px">
              <div v-for="(l, i) in current.data.levels" :key="i" class="row" style="gap: 9px">
                <div class="field" style="margin: 0; width: 110px">
                  <div class="field-label">等级</div>
                  <input v-model.number="l.level" type="number" />
                </div>
                <div class="field" style="margin: 0; flex: 1">
                  <div class="field-label">效果</div>
                  <input v-model="l.desc" placeholder="例如：双向射击 / 命中后爆炸" />
                </div>
                <button class="btn btn-xs" style="margin-top: 18px" @click="removeRow(i)">删除</button>
              </div>
            </div>
            <button class="btn btn-sm" style="margin-top: 10px" @click="addRow">+ 添加等级节点</button>
          </template>

          <!-- 局外成长 -->
          <template v-else>
            <div class="field" style="max-width: 300px">
              <div class="field-label">货币名称</div>
              <input v-model="current.data.currency" placeholder="例如：信仰点" />
            </div>

            <div class="card-title">成长分支</div>
            <div class="stack" style="gap: 8px">
              <div v-for="(b, i) in current.data.branches" :key="i" class="card" style="background: var(--panel-2); padding: 11px">
                <div class="row" style="gap: 9px; align-items: flex-end">
                  <div class="field" style="margin: 0; flex: 1.4">
                    <div class="field-label">分支名称</div>
                    <input v-model="b.name" placeholder="例如：灵力强化" />
                  </div>
                  <div class="field" style="margin: 0; width: 100px">
                    <div class="field-label">最大等级</div>
                    <input v-model.number="b.maxLevel" type="number" />
                  </div>
                  <div class="field" style="margin: 0; flex: 1.6">
                    <div class="field-label">每级效果</div>
                    <input v-model="b.effect" placeholder="例如：每级 +8% 伤害" />
                  </div>
                  <div class="field" style="margin: 0; width: 110px">
                    <div class="field-label">单级成本</div>
                    <input v-model.number="b.cost" type="number" />
                  </div>
                  <button class="btn btn-xs" @click="removeRow(i)">删除</button>
                </div>
              </div>
            </div>
            <button class="btn btn-sm" style="margin-top: 10px" @click="addRow">+ 添加分支</button>

            <div v-if="current.data.branches?.length" class="alert alert-info" style="margin-top: 12px; font-size: 11.5px">
              满级总投入：
              <span class="mono" style="color: var(--accent-2)">
                {{ current.data.branches.reduce((a: number, b: any) => a + (b.maxLevel || 0) * (b.cost || 0), 0) }}
              </span>
              {{ current.data.currency }}
            </div>
          </template>
        </div>

        <div v-if="showJson" class="card">
          <div class="card-title">工程 JSON</div>
          <pre
            class="mono"
            style="
              background: var(--bg-elevated);
              padding: 12px;
              border-radius: 8px;
              font-size: 10.5px;
              max-height: 300px;
              overflow: auto;
              border: 1px solid var(--border-soft);
              margin: 0;
            "
            >{{ JSON.stringify(current, null, 2) }}</pre
          >
        </div>
      </div>
    </div>
  </div>
</template>
