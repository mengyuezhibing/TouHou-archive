<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api, formatSize, type Dashboard } from '../api.ts';
import { HOTKEY_LIST } from '../composables/useHotkeys.ts';
import { store } from '../store.ts';

/**
 * 设置（对应 UI 设计文档第 21 节）。
 * 解析与存储相关配置由后端持有，此处展示其真实状态；
 * 界面偏好保存在浏览器本地。
 */

const health = ref<{ dataDir?: string } | null>(null);
const dashboard = ref<Dashboard | null>(null);
const err = ref('');
const saved = ref('');

/** 界面偏好（localStorage） */
const prefs = reactive({
  showThumbnails: true,
  pagerSize: 60,
  language: 'zh-CN',
  autoExtractSprites: true,
});

const PREFS_KEY = 'trs.prefs';

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) Object.assign(prefs, JSON.parse(raw));
  } catch {
    /* ignore */
  }
}

function savePrefs() {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  saved.value = '界面偏好已保存到本地';
  window.setTimeout(() => (saved.value = ''), 2200);
}

async function load() {
  err.value = '';
  try {
    const [h, d] = await Promise.all([api.health(), api.dashboard()]);
    health.value = h;
    dashboard.value = d;
  } catch (e) {
    err.value = (e as Error).message;
  }
}

onMounted(() => {
  loadPrefs();
  load();
});
</script>

<template>
  <div class="stack">
    <div v-if="err" class="alert alert-danger">{{ err }}</div>
    <div v-if="saved" class="alert alert-ok">{{ saved }}</div>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start">
      <!-- 存储与路径 -->
      <div class="card">
        <div class="card-title">
          资源路径与存储
          <span class="hint">只读 · 由后端服务持有</span>
        </div>
        <table class="table">
          <tbody>
            <tr>
              <td class="mute" style="width: 130px">数据根目录</td>
              <td class="mono" style="font-size: 10.5px; word-break: break-all">{{ health?.dataDir ?? '—' }}</td>
            </tr>
            <tr>
              <td class="mute">数据库文件</td>
              <td class="mono" style="font-size: 10.5px">{{ health?.dataDir }}/trs.db（SQLite · WAL）</td>
            </tr>
            <tr>
              <td class="mute">解包缓存</td>
              <td class="mono" style="font-size: 10.5px">{{ health?.dataDir }}/Game/&lt;作品&gt;/…</td>
            </tr>
            <tr>
              <td class="mute">已导出资源体积</td>
              <td class="mono">{{ formatSize(dashboard?.counts.totalSize ?? 0) }}</td>
            </tr>
          </tbody>
        </table>
        <div class="alert alert-info" style="margin-top: 12px; font-size: 11.5px; line-height: 1.7">
          缓存机制：首次解包会按归档写入 PNG / WAV / JSON 产物并建立索引（耗时取决于归档规模），
          之后所有浏览、检索、预览都直接读取 SQLite 与缓存文件，无需重新解析归解。
        </div>
      </div>

      <!-- 数据库统计 -->
      <div class="card">
        <div class="card-title">
          数据库规模
          <span class="hint">25 张表</span>
        </div>
        <table class="table">
          <tbody>
            <tr><td class="mute">作品 Game</td><td class="mono">{{ dashboard?.counts.games ?? 0 }}</td></tr>
            <tr><td class="mute">归档 Archive</td><td class="mono">{{ dashboard?.counts.archives ?? 0 }}</td></tr>
            <tr><td class="mute">素材 Resource</td><td class="mono">{{ dashboard?.counts.assets ?? 0 }}</td></tr>
            <tr><td class="mute">图片 Asset_Image</td><td class="mono">{{ dashboard?.counts.sprites ?? 0 }}</td></tr>
            <tr><td class="mute">动画 Animation</td><td class="mono">{{ dashboard?.counts.animations ?? 0 }}</td></tr>
            <tr><td class="mute">动画帧 Animation_Frame</td><td class="mono">{{ dashboard?.counts.animationFrames ?? 0 }}</td></tr>
            <tr><td class="mute">弹幕模式 Bullet_Pattern</td><td class="mono">{{ dashboard?.counts.patterns ?? 0 }}</td></tr>
            <tr><td class="mute">弹幕动作 Bullet_Action</td><td class="mono">{{ dashboard?.counts.patternActions ?? 0 }}</td></tr>
            <tr><td class="mute">角色 Character</td><td class="mono">{{ dashboard?.counts.characters ?? 0 }}</td></tr>
            <tr><td class="mute">标签 Tag</td><td class="mono">{{ dashboard?.counts.tags ?? 0 }}</td></tr>
            <tr><td class="mute">剧情文本 Dialogue</td><td class="mono">{{ dashboard?.counts.msgLines ?? 0 }}</td></tr>
          </tbody>
        </table>
      </div>

      <!-- 界面偏好 -->
      <div class="card">
        <div class="card-title">界面偏好</div>
        <label class="row" style="gap: 9px; font-size: 12.5px; margin-bottom: 12px">
          <input v-model="prefs.showThumbnails" type="checkbox" style="width: auto" />
          <span>在素材浏览器中加载缩略图</span>
        </label>
        <div class="field">
          <div class="field-label"><span>每页素材数量</span><span class="val">{{ prefs.pagerSize }}</span></div>
          <input v-model.number="prefs.pagerSize" type="range" min="24" max="200" step="12" />
        </div>
        <div class="field">
          <div class="field-label">界面语言</div>
          <select v-model="prefs.language">
            <option value="zh-CN">简体中文</option>
            <option value="ja-JP">日本語（预留）</option>
            <option value="en-US">English（预留）</option>
          </select>
        </div>
        <label class="row" style="gap: 9px; font-size: 12.5px; margin-bottom: 14px">
          <input v-model="prefs.autoExtractSprites" type="checkbox" style="width: auto" />
          <span>解包时自动深入 ANM 提取精灵</span>
        </label>
        <button class="btn btn-primary btn-sm" @click="savePrefs">保存偏好</button>
      </div>

      <!-- 快捷键 -->
      <div class="card">
        <div class="card-title">快捷键</div>
        <table class="table">
          <tbody>
            <tr v-for="h in HOTKEY_LIST" :key="h.keys">
              <td style="width: 150px"><span class="kbd">{{ h.keys }}</span></td>
              <td class="dim">{{ h.label }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 归档格式支持 -->
      <div class="card">
        <div class="card-title">归档格式支持矩阵</div>
        <table class="table">
          <thead>
            <tr><th>作品</th><th>归档格式</th><th>状态</th></tr>
          </thead>
          <tbody>
            <tr><td>TH06 红魔乡</td><td class="mono">PBG3</td><td><span class="tag tag-green">完整支持</span></td></tr>
            <tr><td>TH07 妖妖梦</td><td class="mono">PBG4</td><td><span class="tag tag-green">完整支持</span></td></tr>
            <tr><td>TH08 永夜抄</td><td class="mono">PBGZ</td><td><span class="tag tag-green">完整支持</span></td></tr>
            <tr><td>TH09 花映塚</td><td class="mono">PBGZ</td><td><span class="tag tag-green">完整支持</span></td></tr>
            <tr><td>TH09.5 及之后</td><td class="mono">th95 / th12-14</td><td><span class="tag tag-amber">解密就绪·表结构待接入</span></td></tr>
          </tbody>
        </table>
        <div class="mute" style="font-size: 11px; margin-top: 10px; line-height: 1.7">
          解析规则对齐 thtk（Touhou Toolkit）规范：位流索引表、LZSS 压缩、th_crypt 分块加解密。
        </div>
      </div>

      <!-- 危险操作 -->
      <div class="card">
        <div class="card-title">维护</div>
        <div class="alert alert-warn" style="font-size: 11.5px; line-height: 1.8">
          <strong>重建索引</strong>：删除数据库文件 <span class="mono">Data/trs.db</span> 与缓存目录后重新解包。
          在终端执行 <span class="mono">rm -rf Data &amp;&amp; npm run seed</span> 可重建演示数据。
        </div>
        <div style="margin-top: 12px" class="row">
          <button class="btn btn-sm" @click="store.init(true)">刷新作品列表</button>
          <button class="btn btn-sm" @click="load">刷新统计</button>
        </div>
      </div>
    </div>
  </div>
</template>
