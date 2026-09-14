<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { api, formatSize, fileUrl, type BgmTrack } from '../api.ts';
import { store } from '../store.ts';

const items = ref<BgmTrack[]>([]);
const loading = ref(false);
const err = ref('');
const playing = ref<BgmTrack | null>(null);
const audioRef = ref<HTMLAudioElement | null>(null);
const audioError = ref(false);
const keyword = ref('');

const editing = ref<BgmTrack | null>(null);
const saving = ref(false);

async function load() {
  loading.value = true;
  try {
    const res = await api.bgm(store.currentGameId || undefined);
    items.value = res.items;
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

function play(t: BgmTrack) {
  if (!t.cache_path) {
    err.value = '该曲目尚未导出音频文件，请在解包中心使用「全部解包」或「仅音频」模式。';
    return;
  }
  audioError.value = false;
  playing.value = t;
  setTimeout(() => {
    audioRef.value?.load();
    void audioRef.value?.play().catch(() => undefined);
  }, 30);
}

/** 首次播放需服务端转码，加载可能要几秒 */
const transcoding = ref(false);

/** 浏览器解码失败（如 New Classic 的自定义 opus 容器）时给出明确提示，而不是无声无息 */
function onAudioError() {
  if (!playing.value) return;
  audioError.value = true;
}

async function saveMeta() {
  if (!editing.value) return;
  saving.value = true;
  try {
    await api.updateBgm(editing.value.id, { boss: editing.value.boss ?? '', scene: editing.value.scene ?? '' });
    editing.value = null;
    await load();
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

const filtered = () => items.value.filter((t) => !keyword.value || t.title.includes(keyword.value) || t.file_name.includes(keyword.value));

watch(() => store.currentGameId, load);
onMounted(load);
</script>

<template>
  <div class="stack">
    <div v-if="err" class="alert alert-danger">{{ err }}</div>

    <div class="toolbar">
      <input v-model="keyword" placeholder="搜索曲名 / 文件名…" style="width: 240px" />
      <div class="topbar-spacer"></div>
      <span class="mute mono" style="font-size: 11.5px">{{ filtered().length }} 首</span>
    </div>

    <div v-if="loading" class="empty"><span class="spinner"></span></div>

    <div v-else-if="!items.length" class="card empty">
      <div class="empty-icon">♪</div>
      <div class="empty-title">暂无 BGM 数据</div>
      <div class="empty-desc">
        在解包中心勾选 <span class="mono">thbgm.dat</span>（会自动标记为 BGM 包）并执行解包，即可提取全部曲目。
      </div>
      <router-link to="/extract" class="btn btn-primary">前往解包中心</router-link>
    </div>

    <template v-else>
      <!-- 播放器 -->
      <div v-if="playing" class="card" style="position: sticky; top: 0; z-index: 10">
        <div class="row-between">
          <div style="flex: 1; min-width: 0">
            <div style="font-size: 13.5px; font-weight: 650">{{ playing.title }}</div>
            <div class="mono mute" style="font-size: 11px">
              {{ playing.file_name }} · {{ playing.codec?.toUpperCase() }} · {{ formatSize(playing.size) }}
            </div>
          </div>
          <audio ref="audioRef" :src="`/api/bgm/${playing.id}/audio`" controls autoplay style="width: 340px; height: 34px" @error="onAudioError"></audio>
          <div v-if="audioError" class="alert alert-danger" style="margin-top: 6px">
            音频播放失败（{{ playing.codec || '未知编码' }}）。TH06NC 的 BGM 是游戏私有封装格式，在线播放暂不支持；
            原始文件已落盘 <code>Data/Game/TH06NC/BGM</code>，可用 vgmstream 等工具本地试听（格式逆向进行中）。
          </div>
          <button class="btn btn-ghost btn-sm" @click="playing = null">✕</button>
        </div>
      </div>

      <div class="card">
        <table class="table">
          <thead>
            <tr>
              <th style="width: 40px">#</th>
              <th>曲目</th>
              <th>格式</th>
              <th>体积</th>
              <th>关联 Boss</th>
              <th>场景</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in filtered()" :key="t.id">
              <td class="mono dim">{{ String(t.index_num + 1).padStart(2, '0') }}</td>
              <td>
                <div style="font-size: 12.5px">{{ t.title }}</div>
                <div class="mono mute" style="font-size: 10.5px">{{ t.file_name }}</div>
              </td>
              <td><span class="tag tag-purple">{{ t.codec?.toUpperCase() ?? '—' }}</span></td>
              <td class="mono dim">{{ formatSize(t.size) }}</td>
              <td>
                <span v-if="t.boss" class="tag tag-accent">{{ t.boss }}</span>
                <span v-else-if="(t.meta as any)?.musicKind === '道中曲'" class="tag tag-blue">道中曲</span>
                <span v-else class="mute">—</span>
              </td>
              <td>
                <span v-if="t.scene" class="tag tag-blue">{{ t.scene }}</span>
                <span v-else class="mute">—</span>
              </td>
              <td class="row" style="gap: 4px">
                <button class="btn btn-xs" :disabled="!t.cache_path" @click="play(t)">▶ 播放</button>
                <a
                  v-if="t.cache_path"
                  class="btn btn-xs"
                  :href="fileUrl(t.cache_path)"
                  :download="`${t.file_name}`"
                  target="_blank"
                  >下载</a
                >
                <button class="btn btn-xs" @click="editing = { ...t }">标注</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- 标注抽屉 -->
    <template v-if="editing">
      <div class="drawer-mask" @click="editing = null"></div>
      <div class="drawer" style="width: min(420px, 92vw)">
        <div class="drawer-head">
          <div style="flex: 1">
            <div style="font-size: 14px; font-weight: 650">曲目标注</div>
            <div class="mute" style="font-size: 11.5px">{{ editing.title }}</div>
          </div>
          <button class="btn btn-ghost btn-sm" @click="editing = null">✕</button>
        </div>
        <div class="drawer-body stack" style="gap: 12px">
          <div class="field">
            <div class="field-label">关联 Boss</div>
            <input v-model="editing.boss" placeholder="例如：芙兰朵露·斯卡雷特" />
          </div>
          <div class="field">
            <div class="field-label">场景 / 出现位置</div>
            <input v-model="editing.scene" placeholder="例如：EX 关底 / 标题画面 / Stage 4" />
          </div>
          <div class="alert alert-info" style="font-size: 11.5px">
            标注信息保存在本地数据库中，用于建立「曲目 ↔ Boss ↔ 场景」的关联检索。
          </div>
        </div>
        <div class="drawer-foot">
          <button class="btn btn-sm" @click="editing = null">取消</button>
          <button class="btn btn-sm btn-primary" :disabled="saving" @click="saveMeta">保存</button>
        </div>
      </div>
    </template>
  </div>
</template>
