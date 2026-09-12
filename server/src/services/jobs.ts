import { db, nowIso } from '../db/index.ts';

/**
 * 后台任务注册表。
 * 解包等耗时操作以任务形式执行，前端轮询进度（对应设计文档 4.3 解包工具模块）。
 */

export interface JobRecord {
  id: string;
  gameId: string;
  kind: string;
  status: 'running' | 'done' | 'failed';
  phase: string;
  progress: number;
  message: string;
  stats: Record<string, unknown> | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const jobs = new Map<string, JobRecord>();

const persistStmt = db.prepare(`
  INSERT INTO job (id, game_code, kind, status, progress, message, stats, started_time, finished_time)
  VALUES (@id, @gameCode, @kind, @status, @progress, @message, @stats, @startedTime, @finishedTime)
  ON CONFLICT(id) DO UPDATE SET
    status = excluded.status, progress = excluded.progress, message = excluded.message,
    stats = excluded.stats, finished_time = excluded.finished_time
`);

function persistJob(job: JobRecord): void {
  persistStmt.run({
    id: job.id,
    gameCode: job.gameId,
    kind: job.kind,
    status: job.status,
    progress: job.progress,
    message: job.message,
    stats: job.stats ? JSON.stringify(job.stats) : null,
    startedTime: job.startedAt,
    finishedTime: job.finishedAt,
  });
}

export function createJob(gameId: string, kind: string): JobRecord {
  const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const job: JobRecord = {
    id,
    gameId,
    kind,
    status: 'running',
    phase: 'init',
    progress: 0,
    message: '任务已创建',
    stats: null,
    error: null,
    startedAt: nowIso(),
    finishedAt: null,
  };
  jobs.set(id, job);
  persistJob(job);
  return job;
}

export function updateJob(id: string, patch: Partial<JobRecord>): void {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch);
  persistJob(job);
}

export function getJob(id: string): JobRecord | null {
  return jobs.get(id) ?? null;
}

export function listJobs(limit = 30): JobRecord[] {
  return [...jobs.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, limit);
}

export function finishJob(id: string, stats: Record<string, unknown>, message: string): void {
  updateJob(id, { status: 'done', phase: 'done', progress: 100, message, stats, finishedAt: nowIso() });
}

export function failJob(id: string, error: string): void {
  updateJob(id, { status: 'failed', phase: 'error', message: error, error, finishedAt: nowIso() });
}

/** 以任务方式运行一个异步函数，自动维护状态 */
export async function runAsJob(
  gameId: string,
  kind: string,
  fn: (report: (phase: string, current: number, total: number, message: string) => void) => Promise<{ stats: Record<string, unknown>; message: string }>,
): Promise<JobRecord> {
  const job = createJob(gameId, kind);
  const report = (phase: string, current: number, total: number, message: string) => {
    const progress = total > 0 ? Math.round((current / total) * 100) : 0;
    updateJob(job.id, { phase, progress: Math.min(99, progress), message });
  };

  void (async () => {
    try {
      const res = await fn(report);
      finishJob(job.id, res.stats, res.message);
    } catch (e) {
      failJob(job.id, (e as Error).message ?? String(e));
    }
  })();

  return job;
}
