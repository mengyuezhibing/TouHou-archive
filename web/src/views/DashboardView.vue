<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, formatSize, CATEGORY_LABELS, type Dashboard } from '../api.ts';
import { store } from '../store.ts';

const data = ref<Dashboard | null>(null);
const loading = ref(true);
const err = ref('');

const PIPELINE = [
  { label: '游戏文件导入', icon: '▤' },
  { label: '自动解包', icon: '⧉' },
  { label: '资源解析', icon: '◮' },
  { label: '素材分类', icon: '▦' },
  { label: '数据分析', icon: '✳' },
  { label: '创作辅助', icon: '⚒' },
];

async function load() {
  loading.value = true;
  try {
    data.value = await api.dashboard();
    err.value = '';
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="stack">
    <div v-if="err" class="alert alert-danger">{{ err }}</div>

    <!-- 流水线示意 -->
    <div class="card" style="padding: 14px 18px">
      <div class="row" style="gap: 0; flex-wrap: wrap">
        <template v-for="(step, i) in PIPELINE" :key="step.label">
          <div class="row" style="gap: 7px">
            <span style="color: var(--accent); font-size: 14px">{{ step.icon }}</span>
            <span style="font-size: 12.5px; font-weight: 550">{{ step.label }}</span>
          </div>
          <span v-if="i < PIPELINE.length - 1" class="mute" style="margin: 0 12px">→</span>
        </template>
      </div>
    </div>

    <!-- 统计 -->
    <div class="stat-grid">
      <div class="stat">
        <div class="stat-value">{{ data?.counts.games ?? 0 }}</div>
        <div class="stat-label">已收录作品</div>
      </div>
      <div class="stat">
        <div class="stat-value">{{ data?.counts.assets ?? 0 }}</div>
        <div class="stat-label">素材总数</div>
      </div>
      <div class="stat">
        <div class="stat-value">{{ data?.counts.sprites ?? 0 }}</div>
        <div class="stat-label">图像资源</div>
      </div>
      <div class="stat">
        <div class="stat-value">{{ data?.counts.sheets ?? 0 }}</div>
        <div class="stat-label">精灵图集</div>
      </div>
      <div class="stat">
        <div class="stat-value">{{ data?.counts.patterns ?? 0 }}</div>
        <div class="stat-label">弹幕模式</div>
      </div>
      <div class="stat">
        <div class="stat-value">{{ data?.counts.spells ?? 0 }}</div>
        <div class="stat-label">符卡记录</div>
      </div>
      <div class="stat">
        <div class="stat-value">{{ data?.counts.bgm ?? 0 }}</div>
        <div class="stat-label">BGM 曲目</div>
      </div>
      <div class="stat">
        <div class="stat-value">{{ data?.counts.msgLines ?? 0 }}</div>
        <div class="stat-label">剧情文本行</div>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: 1.4fr 1fr; gap: 14px; align-items: start">
      <!-- 作品清单 -->
      <div class="card">
        <div class="card-title">
          作品索引
          <span class="hint">共 {{ data?.byGame.length ?? 0 }} 部 · 占用 {{ formatSize(data?.counts.totalSize ?? 0) }}</span>
        </div>

        <div v-if="loading" class="empty"><span class="spinner"></span></div>

        <div v-else-if="!data?.byGame.length" class="empty" style="padding: 32px 16px">
          <div class="empty-icon">▤</div>
          <div class="empty-title">尚未收录任何作品</div>
          <div class="empty-desc">
            前往「游戏管理」扫描本地东方游戏目录，或在终端执行 <code class="mono">npm run seed</code> 生成一套演示数据集快速体验全流程。
          </div>
          <router-link to="/games" class="btn btn-primary">前往游戏管理</router-link>
        </div>

        <table v-else class="table">
          <thead>
            <tr>
              <th>编号</th>
              <th>作品</th>
              <th>年份</th>
              <th>素材</th>
              <th>BGM</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="g in data.byGame" :key="g.id" style="cursor: pointer" @click="store.selectGame(g.id)">
              <td class="mono" style="color: var(--accent-2)">{{ g.id }}</td>
              <td>{{ g.name }}</td>
              <td class="mono dim">{{ g.year }}</td>
              <td class="mono">{{ g.asset_count }}</td>
              <td class="mono">{{ g.bgm_count }}</td>
              <td>
                <span class="tag" :class="g.status === 'extracted' ? 'tag-green' : g.status === 'scanned' ? 'tag-blue' : ''">
                  {{ g.status === 'extracted' ? '已解包' : g.status === 'scanned' ? '已扫描' : '待处理' }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="stack">
        <!-- 分类分布 -->
        <div class="card">
          <div class="card-title">素材分类分布</div>
          <div v-if="!data?.byCategory.length" class="mute" style="font-size: 12px">暂无数据</div>
          <div v-else class="stack" style="gap: 8px">
            <div v-for="c in data.byCategory" :key="c.category">
              <div class="row-between" style="margin-bottom: 3px">
                <span style="font-size: 12px">{{ CATEGORY_LABELS[c.category] ?? c.category }}</span>
                <span class="mono mute" style="font-size: 11.5px">{{ c.count }}</span>
              </div>
              <div class="progress">
                <div
                  class="progress-bar"
                  :style="{ width: `${Math.max(3, (c.count / data.byCategory[0].count) * 100)}%` }"
                ></div>
              </div>
            </div>
          </div>
        </div>

        <!-- 快速入口 -->
        <div class="card">
          <div class="card-title">快速入口</div>
          <div class="stack" style="gap: 6px">
            <router-link to="/extract" class="btn" style="justify-content: flex-start">⧉ 解包新的归档文件</router-link>
            <router-link to="/assets" class="btn" style="justify-content: flex-start">▦ 浏览素材与标签</router-link>
            <router-link to="/danmaku" class="btn" style="justify-content: flex-start">✳ 分析弹幕 / 打开编辑器</router-link>
            <router-link to="/studio" class="btn" style="justify-content: flex-start">⚒ 进入设计工坊</router-link>
          </div>
        </div>

        <div class="card" style="font-size: 11.5px; color: var(--text-mute); line-height: 1.8">
          <div class="card-title" style="margin-bottom: 8px">解析能力说明</div>
          DAT 归档布局、ANM 精灵条目尺寸均由程序自动探测，不依赖版本硬编码；<br />
          ECL 弹幕参数为启发式提取，界面会标注置信度；<br />
          所有推断结果均可在界面中人工修正。
        </div>
      </div>
    </div>
  </div>
</template>
