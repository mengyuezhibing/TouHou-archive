/** 后端 API 封装与共享类型定义 */

import { STATIC_MODE, BASE_URL, staticRequest } from './static-data.ts';

const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // 静态发布模式：站点没有后端，数据来自预生成的 JSON
  if (STATIC_MODE) return staticRequest<T>(path, init);

  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      message = body.error ?? message;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

const get = <T>(p: string) => request<T>(p);
const post = <T>(p: string, body?: unknown) => request<T>(p, { method: 'POST', body: JSON.stringify(body ?? {}) });
const patch = <T>(p: string, body?: unknown) => request<T>(p, { method: 'PATCH', body: JSON.stringify(body ?? {}) });
const del = <T>(p: string) => request<T>(p, { method: 'DELETE' });

// ---------------------------------------------------------------- 类型

export interface Game {
  id: string;
  name: string;
  name_jp: string;
  version: string;
  engine: string;
  year: number;
  path: string;
  exe_path: string | null;
  kind: string;
  status: string;
  note: string;
  scanned_at: string;
  extracted_at: string | null;
}

export interface Asset {
  id: string;
  game_id: string;
  archive_id: number;
  entry_name: string;
  display_name: string;
  ext: string;
  kind: string;
  category: string;
  role: string;
  size: number;
  width: number;
  height: number;
  entry_offset: number;
  cache_path: string | null;
  content_hash: string;
  tags: string[];
  meta: Record<string, any>;
  created_at: string;
}

export interface Archive {
  id: number;
  game_id: string;
  file_name: string;
  file_path: string;
  size: number;
  entry_count: number;
  layout: string;
  confidence: number;
  notes: string;
  parsed_at: string;
}

export interface Character {
  id: string;
  game_id: string;
  name: string;
  role: string;
  source: string;
  sprite_count: number;
  animation_count: number;
  colors: string[];
  attack: string | null;
  tags: string[];
  meta: Record<string, any>;
}

export interface Pattern {
  id: string;
  game_id: string;
  name: string;
  source_asset: string;
  type: string;
  params: Record<string, any>;
  origin: string;
  tags: string[];
  note: string;
  created_at: string;
  updated_at: string;
  action_count?: number;
}

/** Bullet_Action 表：弹幕动作时间轴的一项 */
export interface PatternAction {
  id: number;
  pattern_id: number;
  time: number;
  action_type: string;
  parameter: Record<string, any>;
}

/** Animation 表 */
export interface AnimationRecord {
  id: number;
  resource_id: number;
  resource_code?: string;
  resource_name?: string;
  name: string;
  frame_count: number;
  fps: number;
  loop: number;
  meta: Record<string, any>;
}

/** Animation_Frame 表：帧序列，携带对应精灵的可读编码 */
export interface AnimationFrameRecord {
  id: number;
  animation_id: number;
  frame_index: number;
  duration: number;
  image_id: number | null;
  image_code: string | null;
  image_path: string | null;
  x: number;
  y: number;
  rotation: number;
  scale: number;
}

export interface Spell {
  id: string;
  game_id: string;
  boss: string;
  name: string;
  difficulty: string;
  duration: number;
  pattern_type: string;
  pattern_json: Record<string, any>;
  evaluation: string;
  reference: string;
  source: string;
}

export interface BgmTrack {
  id: string;
  game_id: string;
  index_num: number;
  title: string;
  file_name: string;
  codec: string;
  size: number;
  cache_path: string | null;
  boss: string | null;
  scene: string | null;
  meta: Record<string, any>;
}

export interface JobRecord {
  id: string;
  gameId: string;
  kind: string;
  status: 'running' | 'done' | 'failed';
  phase: string;
  progress: number;
  message: string;
  stats: Record<string, any> | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface Dashboard {
  counts: {
    games: number;
    archives: number;
    assets: number;
    sprites: number;
    sheets: number;
    patterns: number;
    spells: number;
    bgm: number;
    msgLines: number;
    characters: number;
    totalSize: number;
  };
  byCategory: Array<{ category: string; count: number }>;
  byGame: Array<{ id: string; name: string; year: number; status: string; path: string; asset_count: number; bgm_count: number }>;
}

export interface Design {
  id: string;
  kind: string;
  name: string;
  data: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface DanmakuParams {
  type: 'ring' | 'fan' | 'spiral' | 'random' | 'laser' | 'aimed' | 'wave' | 'homing';
  count: number;
  speed: number;
  angle: number;
  spread: number;
  rotationPerWave: number;
  rotation: boolean;
  rotationSpeed: number;
  waves: number;
  waveInterval: number;
  accel: number;
  jitter: number;
  speedJitter: number;
  /** 追踪弹的恒定转向率（度/秒） */
  turnSpeed: number;
  /** 波浪弹的频率（Hz）与振幅 */
  frequency: number;
  amplitude: number;
  origin: { x: number; y: number };
  seed: number;
}

export interface SimBullet {
  id: number;
  wave: number;
  index: number;
  angle: number;
  speed: number;
  accel: number;
  spawnFrame: number;
  /** 波浪运动参数（正弦垂直偏移） */
  waveMotion?: { frequency: number; amplitude: number };
  /** 追踪转向率（度/秒），恒定转向率下弹道为圆弧 */
  turnSpeed?: number;
}

export interface SimResult {
  params: DanmakuParams;
  bullets: SimBullet[];
  totalFrames: number;
  stats: {
    bulletCount: number;
    waves: number;
    avgSpeed: number;
    angleSpan: number;
    densityPerSecond: number;
  };
  described?: { kind: string; label: string };
}

/** 归档检视：条目索引项 */
export interface InspectedEntry {
  index: number;
  name: string;
  displayName?: string;
  size: number;
  zsize: number;
  offset: number;
  group: string;
  previewable: boolean;
  extra?: string;
}

export interface InspectResult {
  filePath: string;
  fileName: string;
  layout: string;
  kind: string;
  confidence: number;
  mayBeEncrypted: boolean;
  notes: string[];
  entries: InspectedEntry[];
}

/** 归档检视：单条目的结构摘要 */
export interface EntryDetail {
  index: number;
  name: string;
  size: number;
  zsize: number;
  offset: number;
  group: string;
  magicKind: string;
  magicLabel: string;
  isImage: boolean;
  imageFormat?: string;
  width?: number;
  height?: number;
  anm?: { numSprites: number; numScripts: number; spriteEntrySize: number; pixelFormat: number; imageKinds: Record<string, number> };
  ecl?: { subCount: number; totalInstructions: number; inference: Array<{ kind: string; label: string }> };
  msg?: { lines: number; layout: string; sample: string[] };
  hexPreview: string;
}

export interface DetectedGame {
  id: string;
  name: string;
  nameJp: string;
  version: string;
  engine: string;
  year: number;
  kind: string;
  path: string;
  exePath: string | null;
  exeFound: boolean;
  datFiles: Array<{ name: string; path: string; size: number }>;
  otherFiles: Array<{ name: string; path: string; size: number }>;
  supported: boolean;
  note: string;
}

// ---------------------------------------------------------------- API

export const api = {
  // 基础
  health: () => get<{ ok: boolean; dataDir: string }>('/health'),
  dashboard: () => get<Dashboard>('/dashboard'),
  titles: () => get<{ items: Array<Record<string, any>> }>('/titles'),

  // 游戏
  scan: (path: string, doImport = true) =>
    post<{ games: DetectedGame[]; scannedFiles: number; notes: string[] }>('/games/scan', { path, import: doImport }),
  games: () => get<{ items: Game[] }>('/games'),
  game: (id: string) => get<{ game: Game; archives: Archive[]; title: Record<string, any> | null }>(`/games/${id}`),
  deleteGame: (id: string) => del<{ ok: boolean }>(`/games/${id}`),
  probe: (id: string, path?: string) =>
    post<{ dir: string; files: Array<{ name: string; path: string; size: number; isDat: boolean; isBgm: boolean; isExe: boolean; selectable: boolean }> }>(
      `/games/${id}/probe`,
      { path },
    ),
  extract: (id: string, body: { files?: string[]; preset?: string; modes?: Record<string, boolean>; maxSpritesPerAnm?: number }) =>
    post<{ jobId: string; files: number; modes: Record<string, boolean> }>(`/games/${id}/extract`, body),

  /** 索引游戏目录下的独立文件（BGM 逐曲 wav 等），原地引用不复制 */
  indexLooseFiles: (gameId: string, dir?: string, includeImages = false) =>
    post<{ scanned: number; indexed: number; tracks: number; skipped: number; warnings: string[] }>(`/games/${gameId}/index-loose`, {
      dir,
      includeImages,
    }),

  /** 角色身份识别：依据符卡名反查角色并建立关联 */
  identify: (gameId: string) =>
    post<{
      renamed: number;
      created: number;
      spellsLinked: number;
      patternsLinked: number;
      animationsLinked: number;
      details: Array<{
        key: string;
        name: string;
        nameJp: string;
        type: string;
        stage: number | null;
        spells: number;
        patterns: number;
        animations: number;
        assets: number;
        wiki: string;
        mappingMethod: string;
      }>;
      warnings: string[];
    }>(`/games/${gameId}/identify`),

  /** 自动分类填充：资源 → 角色库 / 怪物库 / Boss / 符卡库 / 文本分析 */
  autoClassify: (gameId: string) =>
    post<{
      characters: number;
      characterAssets: number;
      enemies: number;
      bosses: number;
      spells: number;
      dialogueLinked: number;
      warnings: string[];
    }>(`/games/${gameId}/auto-classify`),

  // 任务
  jobs: () => get<{ items: JobRecord[] }>('/jobs'),
  job: (id: string) => get<JobRecord>(`/jobs/${id}`),

  // 归档检视（不解包，仅浏览）
  inspectArchive: (path: string, gameId?: string) => post<InspectResult>('/archives/inspect', { path, gameId }),
  inspectEntry: (path: string, index: number, gameId?: string) => post<EntryDetail>('/archives/entry', { path, index, gameId }),
  archivePreviewUrl: (path: string, index: number, gameId?: string) =>
    `/api/archives/preview?path=${encodeURIComponent(path)}&index=${index}${gameId ? `&gameId=${encodeURIComponent(gameId)}` : ''}`,

  // 素材
  assets: (params: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
    return get<{ total: number; items: Asset[]; limit: number; offset: number }>(`/assets?${q}`);
  },
  asset: (id: string) => get<Asset>(`/assets/${id}`),
  updateAsset: (id: string, body: Record<string, unknown>) => patch<Asset>(`/assets/${id}`, body),
  addTag: (id: string, tag: string) => post<Asset>(`/assets/${id}/tags`, { tag }),
  removeTag: (id: string, tag: string) => del<Asset>(`/assets/${id}/tags/${encodeURIComponent(tag)}`),
  categories: (gameId?: string) => get<{ items: Array<{ category: string; count: number }> }>(`/assets/categories${gameId ? `?gameId=${gameId}` : ''}`),
  tags: (gameId?: string) => get<{ items: Array<{ tag: string; count: number }> }>(`/tags${gameId ? `?gameId=${gameId}` : ''}`),
  roles: (gameId?: string) => get<{ items: Array<{ role: string; label: string; assetIds: string[]; hint: string }>; sampled: number; total: number }>(`/roles${gameId ? `?gameId=${gameId}` : ''}`),
  analysis: (id: string) => get<Record<string, any>>(`/assets/${id}/analysis`),
  anmSprites: (id: string) =>
    get<{ anm: { id: string; entryName: string } | null; sheet: Asset | null; items: Asset[] }>(`/assets/${id}/sprites`),

  // 动画（Animation / Animation_Frame 表）
  animations: (resource?: string) =>
    get<{ items: AnimationRecord[] }>(`/animations${resource ? `?resource=${encodeURIComponent(resource)}` : ''}`),
  animation: (id: number) => get<AnimationRecord & { frames: AnimationFrameRecord[] }>(`/animations/${id}`),

  // Boss / 标签字典
  bosses: (gameId?: string) => get<{ items: Array<Record<string, any>> }>(`/bosses${gameId ? `?gameId=${gameId}` : ''}`),
  tagsGrouped: () => get<{ items: Array<{ id: number; name: string; category: string; color: string }> }>('/tags/grouped'),

  // 弹幕模式详情与动作时间轴（Bullet_Action 表）
  patternDetail: (code: string) => get<Pattern & { actions: PatternAction[] }>(`/patterns/${encodeURIComponent(code)}`),
  savePatternActions: (code: string, actions: Array<{ time: number; action_type: string; parameter: Record<string, unknown> }>) =>
    request<Pattern & { actions: PatternAction[] }>(`/patterns/${encodeURIComponent(code)}/actions`, {
      method: 'PUT',
      body: JSON.stringify({ actions }),
    }),
  colors: (id: string) => get<{ dominantHex: string; dominantName: string; names: string[]; palette: Array<{ hex: string; ratio: number; name: string }> }>(`/assets/${id}/colors`),

  // 分析
  characters: (gameId?: string) => get<{ items: Character[] }>(`/characters${gameId ? `?gameId=${gameId}` : ''}`),
  character: (id: string) => get<{ character: Character | null; items: Asset[] }>(`/characters/${id}`),
  enemies: (gameId?: string) => get<{ items: Array<Record<string, any>> }>(`/enemies${gameId ? `?gameId=${gameId}` : ''}`),
  /** 怪物库增强数据：敌机 + 精灵预览 + ECL 行为属性 */
  enemyIntel: (gameId: string) =>
    get<{ items: EnemyIntel[] }>(`/enemies/intel?gameId=${encodeURIComponent(gameId)}`),
  patterns: (gameId?: string, type?: string) => {
    const q = new URLSearchParams();
    if (gameId) q.set('gameId', gameId);
    if (type) q.set('type', type);
    return get<{ items: Pattern[] }>(`/patterns?${q}`);
  },
  savePattern: (body: Record<string, unknown>) => post<Pattern>('/patterns', body),
  deletePattern: (id: string) => del<{ ok: boolean }>(`/patterns/${id}`),

  spells: (gameId?: string) => get<{ items: Spell[] }>(`/spells${gameId ? `?gameId=${gameId}` : ''}`),
  saveSpell: (body: Record<string, unknown>) => post<Spell>('/spells', body),
  deleteSpell: (id: string) => del<{ ok: boolean }>(`/spells/${id}`),
  harvestPreview: (gameId?: string) => post<{ items: Array<{ name: string; gameId: string; sourceLine: string; score: number }> }>('/spells/harvest/preview', { gameId }),
  harvest: (gameId?: string) => post<{ imported: number; skipped: number }>('/spells/harvest', { gameId }),
  seedSpells: (gameId: string) => post<{ imported: number }>('/spells/seed', { gameId }),

  bgm: (gameId?: string) => get<{ items: BgmTrack[] }>(`/bgm${gameId ? `?gameId=${gameId}` : ''}`),
  updateBgm: (id: string, body: Record<string, unknown>) => patch<BgmTrack>(`/bgm/${id}`, body),

  msg: (params: { gameId?: string; q?: string; assetId?: string; limit?: number }) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
    return get<{ items: Array<{ id: number; game_id: string; asset_id: string; time: number; text: string; encoding: string }> }>(`/msg?${q}`);
  },

  // 创作
  designs: (kind?: string) => get<{ items: Design[] }>(`/designs${kind ? `?kind=${kind}` : ''}`),
  design: (id: string) => get<Design>(`/designs/${id}`),
  saveDesign: (body: { id?: string; kind: string; name: string; data: Record<string, unknown> }) => post<Design>('/designs', body),
  deleteDesign: (id: string) => del<{ ok: boolean }>(`/designs/${id}`),

  notes: (targetType?: string, targetId?: string) => {
    const q = new URLSearchParams();
    if (targetType) q.set('targetType', targetType);
    if (targetId) q.set('targetId', targetId);
    return get<{ items: Array<Record<string, any>> }>(`/notes?${q}`);
  },
  saveNote: (body: Record<string, unknown>) => post<Record<string, any>>('/notes', body),
  deleteNote: (id: string) => del<{ ok: boolean }>(`/notes/${id}`),

  // 弹幕
  danmakuDefault: () => get<DanmakuParams>('/danmaku/default'),
  /** ECL 弹幕序列：作品里的真实发射事件，用于回放 */
  danmakuSequences: (gameId: string) =>
    get<{ stages: StageSequences[] }>(`/danmaku/sequences?gameId=${encodeURIComponent(gameId)}`),
  simulate: (params: Partial<DanmakuParams>) => post<SimResult>('/danmaku/simulate', params),
  exportDanmaku: (body: { name: string; format: string; params: Partial<DanmakuParams> }) =>
    request<any>('/danmaku/export', { method: 'POST', body: JSON.stringify(body) }),
};

/**
 * 构造资源文件的可访问 URL。
 * 两种来源：
 *   1. 解包产物 —— 位于 Data 缓存目录，走 /files 静态服务
 *   2. 散落资源 —— 位于游戏目录（原地引用，不复制），走受控的 /api/local-file
 *
 * 静态发布模式下站点可能部署在子路径（如 GitHub Pages 的项目站点），
 * 因此改用 BASE_URL 拼接，让地址跟随 index.html 所在位置解析。
 */
export function fileUrl(cachePath: string | null): string {
  if (!cachePath) return '';
  const normalized = cachePath.replace(/\\/g, '/');
  const idx = normalized.indexOf('/Data/');
  if (idx >= 0) {
    const rel = normalized.slice(idx + '/Data/'.length);
    const encoded = rel.split('/').map(encodeURIComponent).join('/');
    return STATIC_MODE ? `${BASE_URL}files/${encoded}` : `/files/${encoded}`;
  }
  // 散落资源位于游戏原目录，只在本机存在，发布站点里没有对应文件
  if (STATIC_MODE) return '';
  return `/api/local-file?path=${encodeURIComponent(cachePath)}`;
}

/** 判断资源是否可在线播放 */
export function isPlayableAudio(a: { kind?: string; resource_type?: string; ext?: string } | null): boolean {
  if (!a) return false;
  if (a.kind === 'audio' || a.kind === 'bgm') return true;
  if (a.resource_type === 'AUDIO' || a.resource_type === 'MUSIC') return true;
  return ['.wav', '.ogg', '.mp3', '.m4a'].includes((a.ext ?? '').toLowerCase());
}

/**
 * 素材预览 URL（带棋盘底）。
 * 静态模式下没有预览接口，直接用已发布的文件地址；
 * 因此调用处需要把 cache_path 一并传入。
 */
export function previewUrl(id: string, cachePath?: string | null): string {
  if (STATIC_MODE) return fileUrl(cachePath ?? null);
  return `${BASE}/assets/${id}/preview`;
}

export function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export const CATEGORY_LABELS: Record<string, string> = {
  bullet: '弹幕素材',
  effect: '特效',
  character: '角色',
  portrait: '立绘',
  sprite: '精灵贴图',
  sheet: '精灵图集',
  ui: '界面',
  background: '背景',
  audio: '音频',
  se: '音效',
  text: '文本',
  script: '脚本',
  item: '道具',
  image: '图像',
  binary: '二进制',
  unknown: '未分类',
};

// ---------------------------------------------------------------- ECL 弹幕序列

/** 一次弹幕发射事件（从 ECL 的 opcode 0x43 / 0x45 参数区还原） */
export interface DanmakuEvent {
  frame: number;
  time: number;
  count: number;
  /** 初速度（像素/帧） */
  speed: number;
  /** 发射角度（弧度） */
  angle: number;
  /** 角速度（弧度/帧），非 0 即螺旋 */
  spin: number;
  bulletType: number;
  opcode: number;
  confidence: number;
}

export interface DanmakuSequence {
  subIndex: number;
  offset: number;
  durationFrames: number;
  durationSeconds: number;
  events: DanmakuEvent[];
  eventCount: number;
  totalBullets: number;
  angles: number[];
  speeds: number[];
  bulletTypes: number[];
  spiral: boolean;
  warnings: string[];
}

export interface StageSequences {
  stage: number;
  eclFile: string;
  sequences: DanmakuSequence[];
  totalEvents: number;
  totalBullets: number;
  spiralCount: number;
}

// ---------------------------------------------------------------- 敌机情报

/** 一次敌机生成事件（从 ECL 主时间线解析） */
export interface EnemyWave {
  index: number;
  frame: number;
  time: number;
  x: number;
  y: number;
  typeId: number;
  /** -1 表示不设显式血量，生死由行为脚本控制 */
  hp: number;
  score: number;
  opcode: number;
  entry: string;
}

/** 某个关卡的 ECL 行为特征 */
export interface StageEcl {
  stage: number;
  eclFile: string;
  waves: EnemyWave[];
  waveCount: number;
  durationFrames: number;
  durationSeconds: number;
  subCount: number;
  totalInstructions: number;
  typeIds: number[];
  scoreTotal: number;
  explicitHpWaves: number;
  /** 角度候选（弧度） */
  angleHints: number[];
  speedHints: number[];
  opcodeHistogram: Array<{ opcode: number; count: number }>;
  warnings: string[];
}

export interface EnemySprite {
  code: string;
  name: string;
  path: string;
  category: string;
  width: number;
  height: number;
}

export interface EnemyIntel {
  id: number;
  name: string;
  type: string;
  hp: number;
  speed: number;
  description: string;
  stage: number;
  spriteCount: number;
  sprites: EnemySprite[];
  ecl: StageEcl | null;
  gameCode?: string;
}

/** 用途分组：与服务端 classify.ts 的 ROLE_LABELS 保持一致 */
export const ROLE_LABELS: Record<string, string> = {
  player: '自机',
  enemy: '敌机',
  boss: 'Boss',
  portrait: '立绘',
  bullet: '子弹弹幕',
  effect: '特效',
  background: '背景',
  item: '道具',
  ui: '界面',
  audio: '音效',
  unknown: '未分类',
};

/** 用途分组的判定依据（详情面板与筛选提示用） */
export const ROLE_HINTS: Record<string, string> = {
  player: '文件名含 player / 角色名关键词',
  enemy: '文件名含 enm（红魔乡系敌机图集缩写）/ enemy / fairy',
  boss: '文件名含 boss / spell；多数作品的 Boss 与敌机共用图集，需人工标注',
  portrait: '来源指向 face / portrait / cutin 等立绘',
  bullet: '来源指向 etama / bullet / laser 等弹幕贴图',
  effect: '来源指向 effect 等特效贴图',
  background: '来源指向 stgNbg / stage / tile 等场景',
  item: '来源指向 item / power / point 等道具',
  ui: '来源指向 ascii / title / menu / staff 等界面',
  audio: '音频文件（wav / ogg / mid）',
  unknown: '未能从文件名判定，可在详情面板手动指派',
};
