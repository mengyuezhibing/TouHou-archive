/**
 * 静态发布模式的数据源。
 *
 * 发布站点没有后端：所有数据来自 publish 脚本预生成的 JSON（data/*.json），
 * 素材文件是站点内的静态资源（files/**）。这里把 JSON 适配成与 API 相同的
 * 响应形状，使视图代码无需分叉 —— 同一套界面既能连本地工作台，也能跑在线上。
 *
 * 需要文件系统或写操作的能力（扫描 / 解包 / 编辑）在静态模式下不可用，
 * 统一抛出 StaticModeError，由视图的错误提示呈现。
 */

/** 是否构建为静态发布产物（由 VITE_TRS_STATIC=1 注入） */
export const STATIC_MODE = import.meta.env.VITE_TRS_STATIC === '1';

/** 站点基路径：本地为 '/'，静态发布为 './' */
export const BASE_URL = import.meta.env.BASE_URL;

/** 静态模式下不支持的操作 */
export class StaticModeError extends Error {
  constructor(action: string) {
    super(`「${action}」需要本地工作台 —— 当前是在线只读模式，仅供浏览与下载`);
    this.name = 'StaticModeError';
  }
}

const cache = new Map<string, unknown>();

async function loadJson<T>(rel: string): Promise<T> {
  if (cache.has(rel)) return cache.get(rel) as T;
  const res = await fetch(`${BASE_URL}data/${rel}`);
  if (!res.ok) throw new Error(`数据文件缺失：data/${rel}`);
  const data = (await res.json()) as T;
  cache.set(rel, data);
  return data;
}

/** 供视图判断：当前是否处于在线只读模式 */
export function isReadOnly(): boolean {
  return STATIC_MODE;
}

// ---------------------------------------------------------------- 查询辅助

type Dict = Record<string, any>;

const num = (v: string | null, fallback: number) => (v === null ? fallback : Number(v));

/** 复刻服务端 listAssets 的筛选语义，让静态模式下的检索结果保持一致 */
function filterAssets(items: Dict[], q: URLSearchParams): Dict[] {
  let out = items;
  const gameId = q.get('gameId');
  const kind = q.get('kind');
  const category = q.get('category');
  const role = q.get('role');
  const resourceType = q.get('resourceType');
  const tag = q.get('tag');
  const keyword = q.get('q');

  if (gameId) out = out.filter((a) => a.game_id === gameId);
  if (kind) out = out.filter((a) => a.kind === kind);
  if (category) out = out.filter((a) => a.category === category);
  if (role) out = out.filter((a) => a.role === role);
  if (resourceType) out = out.filter((a) => (a.resource_type ?? a.kind) === resourceType);
  if (tag) out = out.filter((a) => (a.tags ?? []).includes(tag));
  if (q.get('hasPreview') === 'true') out = out.filter((a) => !!a.cache_path);
  if (keyword) {
    const k = keyword.toLowerCase();
    out = out.filter((a) =>
      [a.entry_name, a.display_name, a.id].some((v) => String(v ?? '').toLowerCase().includes(k)),
    );
  }

  const sort = q.get('sort');
  const sorted = [...out];
  if (sort === 'size') sorted.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  else if (sort === 'dimension') sorted.sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
  else if (sort === 'recent') sorted.reverse();
  else sorted.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return sorted;
}

function countBy<T extends Dict>(items: T[], key: (x: T) => string) {
  const map = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------- 路由分发

export async function staticRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET') throw new StaticModeError('修改数据');

  const [route, qs = ''] = path.split('?');
  const q = new URLSearchParams(qs);
  const seg = route.split('/').filter(Boolean);
  const [head, ...rest] = seg;
  const arg = rest.length > 0 ? decodeURIComponent(rest[0]) : '';

  switch (head) {
    case 'dashboard':
      return (await loadJson<Dict>('dashboard.json')) as T;

    case 'games': {
      const { items } = await loadJson<{ items: Dict[] }>('games.json');
      if (!arg) return { items } as T;
      const found = items.find((g) => g.id === arg || g.code === arg);
      if (!found) throw new Error('作品不存在');
      const { items: archives } = await loadJson<{ items: Dict[] }>('archives.json');
      return { ...found, archives: archives.filter((a) => a.game_code === found.id) } as T;
    }

    case 'titles': {
      const { items } = await loadJson<{ items: Dict[] }>('games.json');
      return { items } as T;
    }

    case 'archives': {
      const { items } = await loadJson<{ items: Dict[] }>('archives.json');
      return { items: arg ? items.filter((a) => a.game_code === arg) : items } as T;
    }

    case 'assets': {
      const { items } = await loadJson<{ items: Dict[] }>('resources.json');
      // 详情：/assets/:id 及其子资源
      if (arg) {
        const asset = items.find((a) => a.id === arg);
        if (!asset) throw new Error('素材不存在');
        const sub = rest[1];
        if (!sub) return asset as T;

        if (sub === 'sprites') {
          // ANM 拆出的精灵：同一 ANM 的 sprite 通过 meta.sourceAnm 建立关联
          const anmName = asset.entry_name;
          const sprites = items
            .filter((a) => a.meta?.sourceAnm === anmName && a.category !== 'sheet')
            .sort((a, b) => Number(a.meta?.spriteId ?? 0) - Number(b.meta?.spriteId ?? 0));
          const sheet = items.find((a) => a.meta?.sourceAnm === anmName && a.category === 'sheet') ?? null;
          return { anm: { id: asset.id, entryName: anmName }, sheet, items: sprites } as T;
        }

        if (sub === 'colors') {
          // 颜色画像在建库阶段已算好，随 meta 一起导出
          return (
            asset.meta?.colors ?? {
              dominantHex: '#000000',
              dominantName: '未知',
              names: [],
              palette: [],
            }
          ) as T;
        }

        if (sub === 'analysis') {
          // 分析文件已作为可下载资源发布，这里按索引取回并按接口形状聚合
          const index = await loadJson<Record<string, string[]>>('analysis-index.json').catch(() => ({}));
          const files = index[asset.id] ?? [];
          const out: Dict = {};
          for (const rel of files) {
            const key = rel.replace(/^.*\//, '').replace(`${asset.id}_`, '').replace(/\.json$/, '');
            try {
              const res = await fetch(`${BASE_URL}files/${rel.split('/').map(encodeURIComponent).join('/')}`);
              if (res.ok) out[key] = await res.json();
            } catch {
              /* 单个文件失败不影响其余 */
            }
          }
          if (Object.keys(out).length === 0) {
            throw new Error('该素材没有预生成的分析结果');
          }
          return out as T;
        }

        if (sub === 'preview') {
          // 预览图在静态模式下由 fileUrl 直接提供，不会走到这里
          throw new Error('静态模式下的预览请直接使用文件地址');
        }

        return asset as T;
      }

      const filtered = filterAssets(items, q);
      const limit = num(q.get('limit'), 60);
      const offset = num(q.get('offset'), 0);
      return {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        limit,
        offset,
      } as T;
    }

    case 'categories': {
      const { items } = await loadJson<{ items: Dict[] }>('resources.json');
      const scoped = q.get('gameId') ? items.filter((a) => a.game_id === q.get('gameId')) : items;
      const counted = countBy(scoped, (a) => String(a.category ?? 'unknown'));
      const items2 = counted.map((c) => ({ category: c.value, count: c.count }));
      return arg ? (items2 as T) : ({ items: items2 } as T);
    }

    case 'tags': {
      if (rest[0] === 'grouped') return (await loadJson<Dict>('tags-grouped.json')) as T;
      const { items } = await loadJson<{ items: Dict[] }>('tags.json');
      if (arg) {
        const { items: res } = await loadJson<{ items: Dict[] }>('resources.json');
        const scoped = res.filter((a) => a.game_id === arg);
        const counted = countBy(scoped.flatMap((a) => (a.tags ?? []).map((t: string) => ({ t }))), (x) => x.t);
        return { items: counted.map((c) => ({ tag: c.value, count: c.count })) } as T;
      }
      return { items } as T;
    }

    case 'roles': {
      const { items } = await loadJson<{ items: Dict[] }>('resources.json');
      const scoped = q.get('gameId') ? items.filter((a) => a.game_id === q.get('gameId')) : items;
      const grouped = new Map<string, Dict[]>();
      for (const a of scoped) {
        const r = String(a.role ?? 'unknown');
        if (!grouped.has(r)) grouped.set(r, []);
        grouped.get(r)!.push(a);
      }
      const items2 = [...grouped.entries()].map(([role, list]) => ({
        role,
        label: role,
        assetIds: list.slice(0, 200).map((a) => a.id),
        hint: `${list.length} 项素材`,
      }));
      return { items: items2, sampled: scoped.length, total: scoped.length } as T;
    }

    case 'characters': {
      const data = await loadJson<{ items: Dict[]; details: Record<string, Dict> }>('characters.json');
      if (arg) return (data.details[arg] ?? { character: null, items: [] }) as T;
      const scoped = q.get('gameId') ? data.items.filter((c) => c.game_id === q.get('gameId')) : data.items;
      return { items: scoped } as T;
    }

    case 'enemies': {
      const { items } = await loadJson<{ items: Dict[] }>('enemies.json');
      return { items: arg ? items.filter((e) => e.game_id === arg) : items } as T;
    }

    case 'bosses': {
      const { items } = await loadJson<{ items: Dict[] }>('bosses.json');
      return { items: arg ? items.filter((b) => b.game_id === arg) : items } as T;
    }

    case 'spells': {
      const { items } = await loadJson<{ items: Dict[] }>('spells.json');
      return { items: arg ? items.filter((s) => s.game_id === arg) : items } as T;
    }

    case 'patterns': {
      const data = await loadJson<{ items: Dict[]; details: Record<string, Dict> }>('patterns.json');
      if (arg) {
        const detail = data.details[arg];
        if (!detail) throw new Error('弹幕模式不存在');
        return detail as T;
      }
      let list = data.items;
      if (q.get('gameId')) list = list.filter((p) => p.game_id === q.get('gameId'));
      if (q.get('type')) list = list.filter((p) => p.type === q.get('type'));
      return { items: list } as T;
    }

    case 'animations': {
      const data = await loadJson<{ items: Dict[]; details: Record<string, Dict> }>('animations.json');
      if (arg) {
        const detail = data.details[arg];
        if (!detail) throw new Error('动画不存在');
        return detail as T;
      }
      const resource = q.get('resource');
      const list = resource ? data.items.filter((a) => a.resource_code === resource) : data.items;
      return { items: list } as T;
    }

    case 'bgm': {
      const { items } = await loadJson<{ items: Dict[] }>('bgm.json');
      return { items: arg ? items.filter((b) => b.game_id === arg) : items } as T;
    }

    case 'msg': {
      const data = await loadJson<{ byGame: Record<string, Dict[]>; total: number }>('messages.json');
      const gameId = q.get('gameId');
      const keyword = q.get('q');
      const limit = num(q.get('limit'), 300);
      let list: Dict[] = gameId ? (data.byGame[gameId] ?? []) : Object.values(data.byGame).flat();
      if (keyword) {
        const k = keyword.toLowerCase();
        list = list.filter((m) => String(m.text ?? '').toLowerCase().includes(k));
      }
      return { items: list.slice(0, limit), total: list.length } as T;
    }

    case 'designs':
      return (await loadJson<Dict>('designs.json')) as T;

    case 'notes':
      return (await loadJson<Dict>('notes.json')) as T;

    case 'jobs':
      // 静态站点没有后台任务
      return { items: [] } as T;

    case 'health':
      return { ok: true, static: true } as T;

    default:
      throw new Error(`在线只读模式下不支持该接口：${route}`);
  }
}
