<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { api, formatSize, type Asset } from '../api.ts';
import { store } from '../store.ts';

/**
 * 导出中心（对应 UI 设计文档第 20 节）。
 * 把已归档的研究数据转换为引擎可用格式：Godot / Unity / 通用 JSON / CSV。
 */

type Target = 'json' | 'godot' | 'unity' | 'csv';

const TARGETS = [
  { key: 'json' as Target, label: '通用 JSON', desc: '自研引擎 / 任意语言均可解析的中立格式' },
  { key: 'godot' as Target, label: 'Godot 4', desc: 'GDScript 常量表 + 弹幕模式脚本' },
  { key: 'unity' as Target, label: 'Unity', desc: 'ScriptableObject 友好的字段命名结构' },
  { key: 'csv' as Target, label: 'CSV 表格', desc: '便于在 Excel / 表格工具中整理' },
];

const contents = reactive({
  manifest: true,
  animations: true,
  patterns: true,
  characters: true,
  designs: false,
});

const target = ref<Target>('json');
const busy = ref(false);
const err = ref('');
const summary = ref<{ size: number; rows: number; files: string[] } | null>(null);
const preview = ref('');

const stats = reactive({ assets: 0, animations: 0, patterns: 0, characters: 0, designs: 0 });

async function loadStats() {
  try {
    const [a, an, p, c, d] = await Promise.all([
      api.assets({ gameId: store.currentGameId || undefined, limit: 1 }),
      api.animations(),
      api.patterns(store.currentGameId || undefined),
      api.characters(store.currentGameId || undefined),
      api.designs(),
    ]);
    stats.assets = a.total;
    stats.animations = an.items.length;
    stats.patterns = p.items.length;
    stats.characters = c.items.length;
    stats.designs = d.items.length;
  } catch {
    /* ignore */
  }
}

function download(content: string, filename: string, mime = 'application/json') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toCsv(rows: Asset[]): string {
  const head = ['code', 'entry_name', 'display_name', 'resource_type', 'category', 'role', 'size', 'width', 'height', 'tags', 'path'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push(
      [r.id, r.entry_name, r.display_name, r.resource_type ?? r.kind, r.category, r.role, r.size, r.width, r.height, r.tags.join('|'), r.cache_path ?? '']
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
        .join(','),
    );
  }
  return lines.join('\n');
}

/** 生成 Godot GDScript 常量表 */
function toGodot(payload: Record<string, any>): string {
  const lines: string[] = [];
  lines.push('# 由 东方资源研究工作台 导出');
  lines.push(`# 作品：${payload.game ?? 'ALL'}   导出时间：${payload.exportedAt}`);
  lines.push('extends Node');
  lines.push('');
  lines.push('## 素材索引');
  lines.push('const RESOURCES: Array[Dictionary] = [');
  for (const a of (payload.manifest ?? []).slice(0, 3000)) {
    lines.push(
      `\t{"code": "${a.id}", "name": "${a.entry_name}", "type": "${a.resource_type ?? a.kind}", ` +
        `"category": "${a.category}", "size": ${a.size}, "w": ${a.width}, "h": ${a.height}},`,
    );
  }
  lines.push(']');
  lines.push('');
  lines.push('## 弹幕模式（含动作时间轴）');
  lines.push('const PATTERNS: Array[Dictionary] = [');
  for (const p of payload.patterns ?? []) {
    lines.push(`\t{"code": "${p.id}", "name": "${p.name}", "type": "${p.type}", "params": ${JSON.stringify(p.params ?? {})}},`);
  }
  lines.push(']');
  lines.push('');
  lines.push('## 角色');
  lines.push('const CHARACTERS: Array[Dictionary] = [');
  for (const c of payload.characters ?? []) {
    lines.push(`\t{"id": ${c.id}, "name": "${c.name}", "type": "${c.type}", "colors": ${JSON.stringify(c.colors ?? [])}},`);
  }
  lines.push(']');
  return lines.join('\n');
}

/** 生成 Unity ScriptableObject 友好的结构 */
function toUnity(payload: Record<string, any>): string {
  const unity = {
    schema: 'trs.unity/1',
    gameCode: payload.game,
    notes: '字段名采用驼峰，可直接映射到 [Serializable] 类或 ScriptableObject',
    resourceEntries: (payload.manifest ?? []).map((a: any) => ({
      code: a.id,
      name: a.entry_name,
      type: a.resource_type ?? a.kind,
      category: a.category,
      byteSize: a.size,
      width: a.width,
      height: a.height,
    })),
    bulletPatterns: (payload.patterns ?? []).map((p: any) => ({
      code: p.id,
      displayName: p.name,
      patternType: p.type,
      parameters: p.params,
    })),
    characters: payload.characters ?? [],
  };
  return JSON.stringify(unity, null, 2);
}

async function doExport() {
  busy.value = true;
  err.value = '';
  summary.value = null;
  preview.value = '';
  try {
    const payload: Record<string, any> = {
      schema: 'touhou-resource-studio.export/1',
      game: store.currentGameId || 'ALL',
      exportedAt: new Date().toISOString(),
      contents: { ...contents },
    };

    if (contents.manifest) {
      const res = await api.assets({ gameId: store.currentGameId || undefined, limit: 500, hasPreview: true });
      payload.manifest = res.items;
    }
    if (contents.animations) payload.animations = (await api.animations()).items;
    if (contents.patterns) payload.patterns = (await api.patterns(store.currentGameId || undefined)).items;
    if (contents.characters) payload.characters = (await api.characters(store.currentGameId || undefined)).items;
    if (contents.designs) payload.designs = (await api.designs()).items;

    const base = `trs_${store.currentGameId || 'all'}`;
    const files: string[] = [];
    let text = '';

    if (target.value === 'csv') {
      text = toCsv((payload.manifest ?? []) as Asset[]);
      download(text, `${base}_resources.csv`, 'text/csv');
      files.push(`${base}_resources.csv`);
    } else if (target.value === 'godot') {
      text = toGodot(payload);
      download(text, `${base}_godot.gd`, 'text/plain');
      download(JSON.stringify(payload, null, 2), `${base}_data.json`);
      files.push(`${base}_godot.gd`, `${base}_data.json`);
    } else if (target.value === 'unity') {
      text = toUnity(payload);
      download(text, `${base}_unity.json`);
      files.push(`${base}_unity.json`);
    } else {
      text = JSON.stringify(payload, null, 2);
      download(text, `${base}.json`);
      files.push(`${base}.json`);
    }

    preview.value = text.slice(0, 4000);
    summary.value = {
      size: new Blob([text]).size,
      rows:
        (payload.manifest?.length ?? 0) +
        (payload.animations?.length ?? 0) +
        (payload.patterns?.length ?? 0) +
        (payload.characters?.length ?? 0),
      files,
    };
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

const nothingSelected = computed(() => !Object.values(contents).some(Boolean));

onMounted(loadStats);
</script>

<template>
  <div class="stack">
    <div v-if="err" class="alert alert-danger">{{ err }}</div>

    <div class="card">
      <div class="card-title">
        导出目标
        <span class="hint">把研究数据转换为引擎可直接消费的格式</span>
      </div>
      <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px">
        <button
          v-for="t in TARGETS"
          :key="t.key"
          class="btn"
          style="flex-direction: column; align-items: flex-start; gap: 2px; padding: 11px 13px; text-align: left"
          :class="{ 'btn-primary': target === t.key }"
          @click="target = t.key"
        >
          <span style="font-size: 13px; font-weight: 650">{{ t.label }}</span>
          <span style="font-size: 10.5px; opacity: 0.8; white-space: normal">{{ t.desc }}</span>
        </button>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1.2fr; gap: 14px; align-items: start">
      <div class="card">
        <div class="card-title">导出内容</div>
        <div class="stack" style="gap: 10px">
          <label class="row" style="gap: 9px; font-size: 12.5px">
            <input v-model="contents.manifest" type="checkbox" style="width: auto" />
            <span style="flex: 1">素材清单（Resource）</span>
            <span class="mute mono" style="font-size: 11px">{{ stats.assets }} 项</span>
          </label>
          <label class="row" style="gap: 9px; font-size: 12.5px">
            <input v-model="contents.animations" type="checkbox" style="width: auto" />
            <span style="flex: 1">动画与帧序列（Animation / Animation_Frame）</span>
            <span class="mute mono" style="font-size: 11px">{{ stats.animations }} 段</span>
          </label>
          <label class="row" style="gap: 9px; font-size: 12.5px">
            <input v-model="contents.patterns" type="checkbox" style="width: auto" />
            <span style="flex: 1">弹幕模式与动作时间轴（Bullet_Pattern / Bullet_Action）</span>
            <span class="mute mono" style="font-size: 11px">{{ stats.patterns }} 个</span>
          </label>
          <label class="row" style="gap: 9px; font-size: 12.5px">
            <input v-model="contents.characters" type="checkbox" style="width: auto" />
            <span style="flex: 1">角色与配色画像（Character）</span>
            <span class="mute mono" style="font-size: 11px">{{ stats.characters }} 个</span>
          </label>
          <label class="row" style="gap: 9px; font-size: 12.5px">
            <input v-model="contents.designs" type="checkbox" style="width: auto" />
            <span style="flex: 1">创作工程（Boss / 武器 / 局外成长）</span>
            <span class="mute mono" style="font-size: 11px">{{ stats.designs }} 个</span>
          </label>
        </div>

        <button class="btn btn-primary" style="width: 100%; margin-top: 14px" :disabled="busy || nothingSelected" @click="doExport">
          <span v-if="busy" class="spinner"></span>
          {{ busy ? '正在生成…' : `导出为 ${TARGETS.find((t) => t.key === target)?.label}` }}
        </button>

        <div v-if="summary" class="alert alert-ok" style="margin-top: 12px; font-size: 11.5px; line-height: 1.8">
          已生成 {{ summary.files.length }} 个文件（{{ formatSize(summary.size) }}），共 {{ summary.rows }} 条记录。
          <div class="mono" style="margin-top: 4px; font-size: 10.5px">{{ summary.files.join('　') }}</div>
        </div>

        <div class="alert alert-info" style="margin-top: 12px; font-size: 11px; line-height: 1.8">
          精灵图集（Sprite Sheet）已按 TexturePacker JSON Hash 输出在
          <span class="mono">Data/Game/&lt;作品&gt;/Sheets/</span>，
          可与 <span class="mono">.json</span> 一并导入 Godot 的 AtlasTexture 或 Unity 的 Sprite Atlas。
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          导出预览
          <span class="hint">前 4000 字符</span>
        </div>
        <div v-if="!preview" class="empty" style="padding: 40px 16px">
          <div class="empty-icon">⇪</div>
          <div class="empty-title">尚未导出</div>
          <div class="empty-desc">选择目标格式与内容后点击导出，生成结果会在此处预览并自动下载。</div>
        </div>
        <pre
          v-else
          class="mono"
          style="
            background: var(--bg-elevated);
            padding: 12px;
            border-radius: 8px;
            font-size: 10.5px;
            max-height: 480px;
            overflow: auto;
            border: 1px solid var(--border-soft);
            margin: 0;
          "
          >{{ preview }}</pre
        >
      </div>
    </div>
  </div>
</template>
