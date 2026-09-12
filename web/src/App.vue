<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { store } from './store.ts';
import { api } from './api.ts';
import { useHotkeys, HOTKEY_LIST } from './composables/useHotkeys.ts';

const route = useRoute();
const router = useRouter();

/* ---------------------------------------------------------------- 导航 */

const NAV = [
  { group: '工作区', items: [{ path: '/dashboard', label: '工作台', icon: '◈' }] },
  {
    group: '资源',
    items: [
      { path: '/games', label: '游戏库', icon: '▤', badge: 'games' },
      { path: '/extract', label: '解包中心', icon: '⧉' },
      { path: '/assets', label: '素材浏览器', icon: '▦', badge: 'assets' },
      { path: '/animation', label: '动画查看器', icon: '◮', badge: 'animations' },
    ],
  },
  {
    group: '研究',
    items: [
      { path: '/characters', label: '角色库', icon: '👤', badge: 'characters' },
      { path: '/enemies', label: '怪物库', icon: '👾', badge: 'enemies' },
      { path: '/danmaku', label: '弹幕分析', icon: '✳', badge: 'patterns' },
      { path: '/spells', label: '符卡数据库', icon: '✦', badge: 'spells' },
      { path: '/bgm', label: '音乐库', icon: '♪', badge: 'bgm' },
      { path: '/text', label: '文本分析', icon: '¶' },
    ],
  },
  {
    group: '创作',
    items: [
      { path: '/studio', label: '设计工坊', icon: '⚒' },
      { path: '/notes', label: '创作笔记', icon: '✎' },
      { path: '/export', label: '导出中心', icon: '⇪' },
    ],
  },
  { group: '系统', items: [{ path: '/settings', label: '设置', icon: '⚙' }] },
];

/* ---------------------------------------------------------------- 菜单栏 */

const openMenu = ref<string | null>(null);
const showHelp = ref(false);

interface MenuEntry {
  label?: string;
  kbd?: string;
  action?: () => void;
  sep?: boolean;
}

const MENUS = computed<Array<{ label: string; items: MenuEntry[] }>>(() => [
  {
    label: '文件',
    items: [
      { label: '导入 DAT 归档…', kbd: 'Ctrl+E', action: () => router.push('/extract') },
      { label: '扫描游戏目录…', action: () => router.push('/games') },
      { sep: true },
      { label: '导出中心…', kbd: 'Ctrl+Shift+E', action: () => router.push('/export') },
      { sep: true },
      { label: '设置…', action: () => router.push('/settings') },
    ],
  },
  {
    label: '游戏',
    items: [
      { label: '游戏库', action: () => router.push('/games') },
      { label: '重新扫描当前作品', action: rescan },
      { sep: true },
      { label: '角色库', action: () => router.push('/characters') },
      { label: '怪物库', action: () => router.push('/enemies') },
    ],
  },
  {
    label: '工具',
    items: [
      { label: '素材浏览器', kbd: 'Ctrl+F', action: () => router.push('/assets') },
      { label: '动画查看器', kbd: 'P', action: () => router.push('/animation') },
      { label: '弹幕分析器', kbd: 'F5', action: () => router.push('/danmaku') },
      { sep: true },
      { label: '设计工坊', action: () => router.push('/studio') },
      { label: '创作笔记', action: () => router.push('/notes') },
    ],
  },
  {
    label: '导出',
    items: [
      { label: '打开导出中心', action: () => router.push('/export') },
      { label: '导出素材清单 (JSON)', action: () => exportManifest() },
      { label: '导出素材清单 (CSV)', action: () => exportManifest('csv') },
    ],
  },
  {
    label: '帮助',
    items: [
      { label: '快捷键', kbd: '?', action: () => (showHelp.value = true) },
      { label: '关于本工具', action: () => (showHelp.value = true) },
    ],
  },
]);

function toggleMenu(label: string) {
  openMenu.value = openMenu.value === label ? null : label;
}

function runEntry(entry: MenuEntry) {
  openMenu.value = null;
  entry.action?.();
}

function closeMenus() {
  openMenu.value = null;
}

/** 导出素材清单（菜单栏与导出中心共用） */
async function exportManifest(format: 'json' | 'csv' = 'json') {
  try {
    const res = await api.assets({ gameId: store.currentGameId || undefined, limit: 500, hasPreview: true });
    let content: string;
    let mime: string;
    let ext: string;
    if (format === 'csv') {
      const rows = [['code', 'name', 'type', 'category', 'role', 'size', 'width', 'height', 'tags']];
      for (const a of res.items) {
        rows.push([a.id, a.entry_name, a.resource_type ?? a.kind, a.category, a.role, String(a.size), String(a.width), String(a.height), a.tags.join('|')]);
      }
      content = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
      mime = 'text/csv';
      ext = 'csv';
    } else {
      content = JSON.stringify({ game: store.currentGameId, exportedAt: new Date().toISOString(), count: res.items.length, items: res.items }, null, 2);
      mime = 'application/json';
      ext = 'json';
    }
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trs_manifest_${store.currentGameId || 'all'}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    /* 忽略导出失败 */
  }
}

async function rescan() {
  if (!store.currentGameId) return;
  try {
    await api.scan(store.currentGame?.path ?? '', true);
    await store.init(true);
    await refreshCounts();
  } catch {
    /* ignore */
  }
}

/* ---------------------------------------------------------------- 快捷键 */

useHotkeys([
  { keys: 'ctrl+f', handler: () => router.push({ path: '/assets', query: { focus: String(Date.now()) } }), allowInInput: true },
  { keys: 'ctrl+e', handler: () => router.push('/extract') },
  { keys: 'ctrl+shift+e', handler: () => router.push('/export') },
  { keys: 'f5', handler: () => router.push('/danmaku') },
  { keys: 'esc', handler: () => { closeMenus(); showHelp.value = false; }, allowInInput: true },
  { keys: '?', handler: () => (showHelp.value = true) },
]);

/* ---------------------------------------------------------------- 状态 */

const counts = ref<Record<string, number>>({});
let timer: number | undefined;

const pageTitle = computed(() => (route.meta.title as string) ?? '工作台');
const pageSub = computed(() => (route.meta.sub as string) ?? '');

function navBadge(key?: string): string {
  if (!key) return '';
  const v = counts.value[key];
  return v ? String(v) : '';
}

async function refreshCounts() {
  try {
    const d = await api.dashboard();
    counts.value = d.counts as unknown as Record<string, number>;
  } catch {
    /* ignore */
  }
}

onMounted(async () => {
  await store.init();
  await refreshCounts();
  await store.refreshJobs();
  window.addEventListener('click', closeMenus);
  timer = window.setInterval(async () => {
    if (store.runningJobs.length > 0) {
      await store.refreshJobs();
      await refreshCounts();
    }
  }, 1500);
});

onUnmounted(() => {
  if (timer) window.clearInterval(timer);
  window.removeEventListener('click', closeMenus);
});

defineExpose({ refreshCounts });
</script>

<template>
  <div class="app-shell">
    <!-- ============ 顶部菜单栏 ============ -->
    <div class="menubar" @click.stop>
      <span class="menu-brand">TRS</span>
      <div v-for="m in MENUS" :key="m.label" style="position: relative">
        <div class="menu-item" :class="{ open: openMenu === m.label }" @click="toggleMenu(m.label)">
          {{ m.label }}
        </div>
        <div v-if="openMenu === m.label" class="menu-dropdown">
          <template v-for="(entry, i) in m.items" :key="i">
            <div v-if="entry.sep" class="menu-sep"></div>
            <div v-else class="menu-entry" @click="runEntry(entry)">
              <span>{{ entry.label }}</span>
              <span v-if="entry.kbd" class="kbd">{{ entry.kbd }}</span>
            </div>
          </template>
        </div>
      </div>

      <div class="menu-spacer"></div>
      <span class="menu-brand">东方资源研究工作台 v1.0</span>
    </div>

    <!-- ============ 左侧导航 ============ -->
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">
          <div class="brand-orb"></div>
          <div>
            <div class="brand-title">东方资源研究工作台</div>
            <div class="brand-sub">Touhou Resource Studio</div>
          </div>
        </div>
      </div>

      <nav>
        <div v-for="g in NAV" :key="g.group" class="nav-group">
          <div class="nav-label">{{ g.group }}</div>
          <router-link
            v-for="item in g.items"
            :key="item.path"
            :to="item.path"
            class="nav-item"
            :class="{ active: route.path === item.path }"
          >
            <span class="nav-icon">{{ item.icon }}</span>
            <span>{{ item.label }}</span>
            <span v-if="navBadge(item.badge)" class="nav-badge">{{ navBadge(item.badge) }}</span>
          </router-link>
        </div>
      </nav>

      <div style="flex: 1"></div>

      <div v-if="store.runningJobs.length" style="padding: 0 14px">
        <div class="alert alert-info" style="font-size: 11.5px">
          <div class="row" style="gap: 7px">
            <span class="spinner"></span>
            <span>{{ store.runningJobs.length }} 个任务执行中</span>
          </div>
          <div style="margin-top: 6px">{{ store.runningJobs[0].message }}</div>
        </div>
      </div>
    </aside>

    <!-- ============ 主工作区 ============ -->
    <section class="main-area">
      <header class="topbar">
        <div>
          <div class="page-title">{{ pageTitle }}</div>
          <div class="page-sub">{{ pageSub }}</div>
        </div>
        <div class="topbar-spacer"></div>

        <div class="row" style="gap: 8px">
          <span class="mute" style="font-size: 11.5px">当前作品</span>
          <select
            :value="store.currentGameId"
            style="width: 210px"
            @change="store.selectGame(($event.target as HTMLSelectElement).value)"
          >
            <option value="">未选择</option>
            <option v-for="g in store.games" :key="g.id" :value="g.id">[{{ g.id }}] {{ g.name }}</option>
          </select>
        </div>
      </header>

      <main class="content">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </section>

    <!-- ============ 底部状态栏 ============ -->
    <div class="statusbar">
      <div class="status-item">
        <span class="status-dot"></span>
        后端已连接
      </div>
      <div class="status-item">作品 <span class="mono">{{ store.currentGameId || '未选择' }}</span></div>
      <div class="status-item">素材 <span class="mono">{{ counts.assets ?? 0 }}</span></div>
      <div class="status-item">动画 <span class="mono">{{ counts.animations ?? 0 }}</span></div>
      <div class="status-item">弹幕 <span class="mono">{{ counts.patterns ?? 0 }}</span></div>
      <div class="status-item">标签 <span class="mono">{{ counts.tags ?? 0 }}</span></div>
      <div class="menu-spacer"></div>
      <div class="status-item"><span class="kbd">Ctrl+F</span> 搜索</div>
      <div class="status-item"><span class="kbd">Ctrl+E</span> 解包</div>
      <div class="status-item"><span class="kbd">F5</span> 弹幕模拟</div>
    </div>

    <!-- ============ 快捷键弹层 ============ -->
    <template v-if="showHelp">
      <div class="drawer-mask" @click="showHelp = false"></div>
      <div class="drawer" style="width: min(420px, 92vw)">
        <div class="drawer-head">
          <div style="flex: 1">
            <div style="font-size: 14px; font-weight: 650">快捷键</div>
            <div class="mute" style="font-size: 11.5px">东方资源研究工作台 v1.0</div>
          </div>
          <button class="btn btn-ghost btn-sm" @click="showHelp = false">✕</button>
        </div>
        <div class="drawer-body">
          <table class="table">
            <tbody>
              <tr v-for="h in HOTKEY_LIST" :key="h.keys">
                <td style="width: 140px"><span class="kbd">{{ h.keys }}</span></td>
                <td class="dim">{{ h.label }}</td>
              </tr>
            </tbody>
          </table>
          <div class="alert alert-info" style="margin-top: 14px; font-size: 11.5px; line-height: 1.8">
            数据来源：本地 SQLite（Game / Resource / Animation / Bullet_Pattern 等 25 张表）。<br />
            归档解析遵循 thtk 规范，支持 PBG3（红魔乡）/ PBG4（妖妖梦）/ PBGZ（永夜抄·花映塚）。
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
