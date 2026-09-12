import { reactive } from 'vue';
import { api, type Game, type JobRecord } from './api.ts';

/** 全局轻量状态：当前作品、作品列表与后台任务 */
export const store = reactive({
  games: [] as Game[],
  currentGameId: '',
  jobs: [] as JobRecord[],
  ready: false,
  loading: false,
  error: '',

  async init(force = false) {
    if (this.ready && !force) return;
    this.loading = true;
    this.error = '';
    try {
      const { items } = await api.games();
      this.games = items;
      const saved = localStorage.getItem('trs.currentGame');
      if (saved && items.some((g) => g.id === saved)) this.currentGameId = saved;
      else if (!this.currentGameId) this.currentGameId = items[0]?.id ?? '';
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
      this.ready = true;
    }
  },

  selectGame(id: string) {
    this.currentGameId = id;
    localStorage.setItem('trs.currentGame', id);
  },

  get currentGame(): Game | null {
    return this.games.find((g) => g.id === this.currentGameId) ?? null;
  },

  async refreshJobs() {
    try {
      const { items } = await api.jobs();
      this.jobs = items;
    } catch {
      /* ignore */
    }
  },

  get runningJobs(): JobRecord[] {
    return this.jobs.filter((j) => j.status === 'running');
  },
});
