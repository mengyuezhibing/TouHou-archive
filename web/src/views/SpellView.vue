<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { api, type Spell } from '../api.ts';
import { store } from '../store.ts';

const items = ref<Spell[]>([]);
const loading = ref(false);
const err = ref('');
const msg = ref('');
const harvesting = ref(false);
const candidates = ref<Array<{ name: string; gameId: string; sourceLine: string; score: number }>>([]);

const editing = ref<Partial<Spell> | null>(null);
const saving = ref(false);

const difficultyFilter = ref('');

const DIFFICULTIES = ['Easy', 'Normal', 'Hard', 'Lunatic', 'Extra', 'Unknown'];

const grouped = computed(() => {
  const map = new Map<string, Spell[]>();
  for (const s of items.value) {
    if (difficultyFilter.value && s.difficulty !== difficultyFilter.value) continue;
    const key = s.boss || '未标注 Boss';
    const list = map.get(key) ?? [];
    list.push(s);
    map.set(key, list);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
});

async function load() {
  loading.value = true;
  try {
    const res = await api.spells(store.currentGameId || undefined);
    items.value = res.items;
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function harvestPreview() {
  harvesting.value = true;
  msg.value = '';
  try {
    const res = await api.harvestPreview(store.currentGameId || undefined);
    candidates.value = res.items;
    msg.value = res.items.length
      ? `从剧情文本中提取到 ${res.items.length} 个符卡名候选，确认后可批量入库。`
      : '未从剧情文本中提取到符卡名。请确认已解包 MSG 文本（解包模式选择「仅文本」或「全部解包」）。';
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    harvesting.value = false;
  }
}

async function harvestImport() {
  try {
    const res = await api.harvest(store.currentGameId || undefined);
    msg.value = `已导入 ${res.imported} 条，跳过重复 ${res.skipped} 条。`;
    candidates.value = [];
    await load();
  } catch (e) {
    err.value = (e as Error).message;
  }
}

async function seed() {
  if (!store.currentGameId) return;
  await api.seedSpells(store.currentGameId);
  await load();
}

function openNew() {
  editing.value = {
    gameId: store.currentGameId,
    boss: '',
    name: '',
    difficulty: 'Normal',
    duration: 40,
    patternType: '',
    evaluation: '',
    reference: '',
  };
}

function openEdit(s: Spell) {
  editing.value = { ...s };
}

async function save() {
  if (!editing.value?.name) return;
  saving.value = true;
  try {
    await api.saveSpell({ ...editing.value, gameId: editing.value.gameId ?? store.currentGameId });
    editing.value = null;
    await load();
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

async function remove(id: string) {
  await api.deleteSpell(id);
  await load();
}

watch(() => store.currentGameId, load);
onMounted(load);
</script>

<template>
  <div class="stack">
    <div v-if="err" class="alert alert-danger">{{ err }}</div>
    <div v-if="msg" class="alert alert-info">{{ msg }}</div>

    <div class="toolbar">
      <button class="btn btn-primary btn-sm" @click="openNew">+ 新建符卡</button>
      <button class="btn btn-sm" :disabled="harvesting" @click="harvestPreview">
        <span v-if="harvesting" class="spinner"></span>
        从剧情文本自动提取
      </button>
      <button class="btn btn-sm" @click="seed">载入经典符卡参考</button>
      <select v-model="difficultyFilter" style="width: 130px">
        <option value="">全部难度</option>
        <option v-for="d in DIFFICULTIES" :key="d" :value="d">{{ d }}</option>
      </select>
      <div class="topbar-spacer"></div>
      <span class="mute mono" style="font-size: 11.5px">{{ items.length }} 条记录</span>
    </div>

    <!-- 候选 -->
    <div v-if="candidates.length" class="card">
      <div class="card-title">
        符卡名候选
        <span class="hint">按书写形式与置信度排序，可直接批量入库</span>
      </div>
      <div class="chips" style="max-height: 200px; overflow-y: auto">
        <span v-for="c in candidates.slice(0, 80)" :key="c.name" class="tag" :class="c.score > 0.9 ? 'tag-accent' : 'tag-blue'">
          {{ c.name }} <span class="mute mono" style="font-size: 10px">{{ c.score.toFixed(2) }}</span>
        </span>
      </div>
      <button class="btn btn-primary btn-sm" style="margin-top: 12px" @click="harvestImport">
        全部导入符卡库（{{ candidates.length }}）
      </button>
    </div>

    <div v-if="loading" class="empty"><span class="spinner"></span></div>

    <div v-else-if="!items.length" class="card empty">
      <div class="empty-icon">✦</div>
      <div class="empty-title">符卡库为空</div>
      <div class="empty-desc">
        可以从已解包的剧情文本中自动挖掘符卡名（日文符卡通常写作「○○符『××』」），
        也可以手动新建，或载入内置的经典符卡参考快速起步。
      </div>
      <div class="row" style="justify-content: center">
        <button class="btn btn-primary" :disabled="harvesting" @click="harvestPreview">自动提取</button>
        <button class="btn" @click="seed">载入参考符卡</button>
      </div>
    </div>

    <div v-else class="stack">
      <div v-for="[boss, spells] in grouped" :key="boss" class="card">
        <div class="card-title">
          {{ boss }}
          <span class="hint">{{ spells.length }} 张</span>
        </div>
        <table class="table">
          <thead>
            <tr>
              <th>符卡名</th>
              <th>难度</th>
              <th>持续时间</th>
              <th>弹幕类型</th>
              <th>来源</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in spells" :key="s.id">
              <td>
                <div style="font-size: 12.5px">{{ s.name }}</div>
                <div v-if="s.evaluation" class="mute" style="font-size: 10.5px; max-width: 420px">{{ s.evaluation }}</div>
              </td>
              <td><span class="tag">{{ s.difficulty }}</span></td>
              <td class="mono dim">{{ s.duration || '—' }}</td>
              <td>
                <span v-if="s.pattern_type" class="tag tag-blue">{{ s.pattern_type }}</span>
                <span v-else class="mute">—</span>
              </td>
              <td class="mono mute" style="font-size: 10.5px">{{ s.source }}</td>
              <td class="row" style="gap: 4px">
                <button class="btn btn-xs" @click="openEdit(s)">编辑</button>
                <button class="btn btn-xs" @click="remove(s.id)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 编辑抽屉 -->
    <template v-if="editing">
      <div class="drawer-mask" @click="editing = null"></div>
      <div class="drawer" style="width: min(480px, 92vw)">
        <div class="drawer-head">
          <div style="flex: 1">
            <div style="font-size: 14px; font-weight: 650">{{ editing.id ? '编辑符卡' : '新建符卡' }}</div>
            <div class="mute" style="font-size: 11.5px">符卡档案将保存设计评价与参考用途，供后续研究检索</div>
          </div>
          <button class="btn btn-ghost btn-sm" @click="editing = null">✕</button>
        </div>

        <div class="drawer-body stack" style="gap: 12px">
          <div class="field">
            <div class="field-label">符卡名</div>
            <input v-model="editing.name" placeholder="例如：恋符「マスタースパーク」" />
          </div>
          <div class="field">
            <div class="field-label">Boss</div>
            <input v-model="editing.boss" placeholder="例如：雾雨魔理沙" />
          </div>
          <div class="row" style="gap: 10px">
            <div class="field" style="flex: 1">
              <div class="field-label">难度</div>
              <select v-model="editing.difficulty">
                <option v-for="d in DIFFICULTIES" :key="d" :value="d">{{ d }}</option>
              </select>
            </div>
            <div class="field" style="flex: 1">
              <div class="field-label">持续时间（秒）</div>
              <input v-model.number="editing.duration" type="number" />
            </div>
          </div>
          <div class="field">
            <div class="field-label">弹幕类型</div>
            <input v-model="editing.patternType" placeholder="ring / fan / spiral / laser …" />
          </div>
          <div class="field">
            <div class="field-label">设计评价</div>
            <textarea v-model="editing.evaluation" rows="4" placeholder="弹幕密度曲线、视觉引导、难度容错等观察记录"></textarea>
          </div>
          <div class="field">
            <div class="field-label">参考用途</div>
            <input v-model="editing.reference" placeholder="例如：可作为自研 Boss 第二阶段参考" />
          </div>
        </div>

        <div class="drawer-foot">
          <button class="btn btn-sm" @click="editing = null">取消</button>
          <button class="btn btn-sm btn-primary" :disabled="saving" @click="save">保存</button>
        </div>
      </div>
    </template>
  </div>
</template>
