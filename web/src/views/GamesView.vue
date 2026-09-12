<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, formatSize, type DetectedGame, type Game, type Archive } from '../api.ts';
import { store } from '../store.ts';

const router = useRouter();
const dir = ref('D:/Touhou/');
const scanning = ref(false);
const scanResult = ref<{ games: DetectedGame[]; scannedFiles: number; notes: string[] } | null>(null);
const err = ref('');

const titles = ref<Array<Record<string, any>>>([]);
const detail = ref<{ game: Game; archives: Archive[] } | null>(null);
const busy = ref(false);
const looseMsg = ref('');

async function doScan() {
  scanning.value = true;
  err.value = '';
  scanResult.value = null;
  try {
    const res = await api.scan(dir.value);
    scanResult.value = res;
    await store.init(true);
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    scanning.value = false;
  }
}

async function openGame(id: string) {
  detail.value = null;
  try {
    const res = await api.game(id);
    detail.value = { game: res.game, archives: res.archives };
  } catch (e) {
    err.value = (e as Error).message;
  }
}

async function removeGame(id: string) {
  if (!confirm(`确认从工作台移除作品 ${id} 的索引？（不会删除游戏本体文件）`)) return;
  busy.value = true;
  try {
    await api.deleteGame(id);
    detail.value = null;
    await store.init(true);
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

/** 索引游戏目录下的独立文件（BGM 逐曲 wav 等），原地引用不复制 */
async function indexLoose() {
  if (!detail.value) return;
  busy.value = true;
  err.value = '';
  looseMsg.value = '';
  try {
    const r = await api.indexLooseFiles(detail.value.game.id);
    looseMsg.value = `扫描 ${r.scanned} 个文件 → 新索引 ${r.indexed} 个（音频 ${r.tracks} 首），已存在 ${r.skipped} 个`;
    await store.init(true);
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

/** 自动分类填充：把已索引资源归入各研究模块 */
async function runAutoClassify() {
  if (!detail.value) return;
  busy.value = true;
  err.value = '';
  looseMsg.value = '';
  try {
    const r = await api.autoClassify(detail.value.game.id);
    looseMsg.value =
      `角色 ${r.characters} 个（关联素材 ${r.characterAssets}）· 怪物 ${r.enemies} 个 · ` +
      `Boss ${r.bosses} 个 · 符卡 ${r.spells} 张 · 对话分组 ${r.dialogueLinked} 行`;
    await store.init(true);
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

/** 依据符卡名识别角色身份并建立关联 */
async function runIdentify() {
  if (!detail.value) return;
  busy.value = true;
  err.value = '';
  looseMsg.value = '';
  try {
    const r = await api.identify(detail.value.game.id);
    looseMsg.value =
      `识别并改名 ${r.renamed} 个角色 · 新建 ${r.created} 个 · 关联符卡 ${r.spellsLinked} 张 · ` +
      `弹幕模式 ${r.patternsLinked} 个 · 动画资源 ${r.animationsLinked} 项`;
    await store.init(true);
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

function goExtract(id: string) {
  store.selectGame(id);
  router.push('/extract');
}

onMounted(async () => {
  const res = await api.titles().catch(() => ({ items: [] }));
  titles.value = res.items;
});
</script>

<template>
  <div class="stack">
    <div v-if="err" class="alert alert-danger">{{ err }}</div>

    <!-- 扫描 -->
    <div class="card">
      <div class="card-title">
        扫描游戏目录
        <span class="hint">程序会递归查找 thXX.exe / thXX.dat 并自动识别作品</span>
      </div>
      <div class="row">
        <input v-model="dir" placeholder="例如 D:/Touhou/ 或 /Users/you/Games/Touhou" @keyup.enter="doScan" />
        <button class="btn btn-primary" :disabled="scanning" @click="doScan">
          <span v-if="scanning" class="spinner"></span>
          {{ scanning ? '扫描中' : '扫描' }}
        </button>
      </div>

      <div v-if="scanResult" style="margin-top: 14px" class="stack">
        <div v-for="n in scanResult.notes" :key="n" class="mute" style="font-size: 11.5px">{{ n }}</div>

        <div v-if="!scanResult.games.length" class="alert alert-warn">
          未识别到作品。请确认目录中包含 <span class="mono">th06.dat</span>、<span class="mono">th06.exe</span> 这类文件。
        </div>

        <div v-for="g in scanResult.games" :key="g.id" class="card" style="background: var(--panel-2)">
          <div class="row-between">
            <div>
              <div class="row" style="gap: 8px">
                <span class="tag tag-accent mono">{{ g.id }}</span>
                <strong style="font-size: 13.5px">{{ g.name }}</strong>
                <span class="dim" style="font-size: 12px">{{ g.nameJp }}</span>
                <span class="tag">{{ g.year }}</span>
                <span class="tag">{{ g.engine }}</span>
                <span v-if="g.exeFound" class="tag tag-green">EXE 已找到</span>
              </div>
              <div class="mono mute" style="font-size: 11px; margin-top: 5px">{{ g.path }}</div>
            </div>
            <button class="btn btn-sm" @click="goExtract(g.id)">解包此作品 →</button>
          </div>

          <div v-if="g.datFiles.length" style="margin-top: 10px">
            <div class="mute" style="font-size: 11px; margin-bottom: 4px">发现归档文件</div>
            <div class="chips">
              <span v-for="f in g.datFiles" :key="f.path" class="tag mono">
                {{ f.name }} · {{ formatSize(f.size) }}
              </span>
            </div>
          </div>
          <div v-if="g.note" class="mute" style="font-size: 11px; margin-top: 8px">说明：{{ g.note }}</div>
        </div>
      </div>
    </div>

    <!-- 已收录作品 -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start">
      <div class="card">
        <div class="card-title">工作台已收录（{{ store.games.length }}）</div>
        <div v-if="!store.games.length" class="empty" style="padding: 30px">
          <div class="empty-title">暂无作品</div>
        </div>
        <table v-else class="table">
          <thead>
            <tr><th>编号</th><th>作品</th><th>年份</th><th>状态</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="g in store.games" :key="g.id">
              <td class="mono" style="color: var(--accent-2)">{{ g.id }}</td>
              <td>{{ g.name }}</td>
              <td class="mono dim">{{ g.year }}</td>
              <td>
                <span class="tag" :class="g.status === 'extracted' ? 'tag-green' : 'tag-blue'">
                  {{ g.status === 'extracted' ? '已解包' : '已扫描' }}
                </span>
              </td>
              <td class="row" style="gap: 4px">
                <button class="btn btn-xs" @click="openGame(g.id)">详情</button>
                <button class="btn btn-xs" @click="goExtract(g.id)">解包</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 详情 -->
      <div class="card">
        <div class="card-title">
          作品详情
          <span v-if="detail" class="hint">{{ detail.game.id }}</span>
        </div>

        <div v-if="!detail" class="empty" style="padding: 30px">
          <div class="empty-desc" style="margin-bottom: 0">从左侧列表选择一部作品查看归档解析详情。</div>
        </div>

        <div v-else class="stack" style="gap: 10px">
          <div>
            <div style="font-size: 15px; font-weight: 650">{{ detail.game.name }}</div>
            <div class="dim" style="font-size: 12px">{{ detail.game.name_jp }} · {{ detail.game.year }} · {{ detail.game.engine }}</div>
          </div>
          <div class="mono mute" style="font-size: 11px">{{ detail.game.path }}</div>
          <div v-if="detail.game.note" class="alert alert-info" style="font-size: 11.5px">{{ detail.game.note }}</div>

          <div>
            <div class="mute" style="font-size: 11px; margin-bottom: 6px">归档解析结果</div>
            <div v-if="!detail.archives.length" class="mute" style="font-size: 12px">尚未解包</div>
            <table v-else class="table">
              <thead>
                <tr><th>文件</th><th>条目</th><th>布局</th><th>置信度</th></tr>
              </thead>
              <tbody>
                <tr v-for="a in detail.archives" :key="a.id">
                  <td class="mono">{{ a.file_name }}</td>
                  <td class="mono">{{ a.entry_count }}</td>
                  <td class="mono dim">{{ a.layout }}</td>
                  <td>
                    <span class="tag" :class="a.confidence > 0.7 ? 'tag-green' : a.confidence > 0.4 ? 'tag-amber' : 'tag-accent'">
                      {{ Math.round(a.confidence * 100) }}%
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-if="detail.archives[0]?.notes" class="mute" style="font-size: 11px; margin-top: 8px; line-height: 1.7">
              {{ detail.archives[0].notes }}
            </div>
          </div>

          <div class="row" style="gap: 6px; flex-wrap: wrap">
            <button class="btn btn-primary btn-sm" @click="goExtract(detail.game.id)">前往解包</button>
            <button class="btn btn-sm" :disabled="busy" @click="indexLoose">
              <span v-if="busy" class="spinner"></span>
              索引目录独立文件
            </button>
            <button class="btn btn-sm" :disabled="busy" @click="runAutoClassify">
              <span v-if="busy" class="spinner"></span>
              自动分类填充
            </button>
            <button class="btn btn-sm" :disabled="busy" @click="runIdentify">
              <span v-if="busy" class="spinner"></span>
              识别角色身份
            </button>
            <button class="btn btn-sm" :disabled="busy" @click="removeGame(detail.game.id)">移除索引</button>
          </div>

          <div v-if="looseMsg" class="alert alert-ok" style="font-size: 11.5px">{{ looseMsg }}</div>
          <div class="mute" style="font-size: 11px; line-height: 1.7">
            独立文件指不经过 DAT 归档的资源：红魔乡的 BGM 是 17 个散落的 .wav，
            这类文件以**原地引用**方式登记（不复制，避免占用数 GB 缓存），可直接在线播放。
          </div>
        </div>
      </div>
    </div>

    <!-- 支持列表 -->
    <div class="card">
      <div class="card-title">
        支持的作品格式
        <span class="hint">Windows 平台 ZUN 引擎整数作与主要小数点作</span>
      </div>
      <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 8px">
        <div v-for="t in titles" :key="t.id" class="card" style="padding: 10px 12px; background: var(--panel-2)">
          <div class="row" style="gap: 7px">
            <span class="mono" style="color: var(--accent-2); font-size: 11.5px">{{ t.id }}</span>
            <span class="mute mono" style="font-size: 10.5px">{{ t.year }}</span>
          </div>
          <div style="font-size: 12.5px; margin-top: 3px">{{ t.name }}</div>
          <div class="mono mute" style="font-size: 10px; margin-top: 2px">{{ t.mainDat }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
