/**
 * 重新分类已入库的素材。
 *
 * 分类规则（services/classify.ts）会随对作品命名习惯的了解而调整，
 * 例如红魔乡系把敌机图集命名为 stgNenm.anm（enm = enemy），
 * 早期只匹配 enemy 关键词，导致全部敌机素材落到「未分类」。
 *
 * 分类只依赖条目名与归档名，不需要重新读取归档字节，
 * 因此调整规则后重跑这一步即可，无需重新解包。
 *
 * 用法：npx tsx src/scripts/reclassify.ts [--game TH06] [--dry]
 */
import { db } from '../db/index.ts';
import { classifyEntry, ROLE_LABELS } from '../services/classify.ts';
import type { MagicInfo } from '../core/magic.ts';

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
};

const GAME = opt('--game');
const DRY = has('--dry');

/** 从扩展名还原一个最小 MagicInfo —— 重新分类只需知道大类，不需要真读文件头 */
function magicFromExt(ext: string): MagicInfo {
  const e = (ext || '').toLowerCase();
  const base = { ext: e, mime: '', label: '' };
  if (['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp'].includes(e)) {
    return { kind: 'png', ...base, image: true, audio: false, text: false };
  }
  if (['.wav', '.ogg', '.mid', '.mp3', '.m4a'].includes(e)) {
    return { kind: 'wav', ...base, image: false, audio: true, text: false };
  }
  if (['.txt', '.msg', '.json'].includes(e)) {
    return { kind: 'text', ...base, image: false, audio: false, text: true };
  }
  return { kind: 'binary', ...base, image: false, audio: false, text: false };
}

interface Row {
  id: string;
  code: string;
  game_id: number;
  entry_name: string;
  display_name: string;
  ext: string;
  kind: string;
  category: string;
  role: string;
  width: number;
  height: number;
  archive_name: string | null;
  /** 所属作品代码，用于分派版本专属分类规则 */
  game_code: string | null;
}

function main() {
  console.log('\n  素材重新分类\n');

  const where = GAME ? 'WHERE g.code = ?' : '';
  const params = GAME ? [GAME] : [];
  // 宽高存放在 asset_image 表（resource 表本身不含尺寸列）
  const rows = db
    .prepare(
      `SELECT r.id, r.code, r.game_id, r.filename AS entry_name, r.display_name, r.ext, r.kind,
              r.category, r.role, COALESCE(i.width, 0) AS width, COALESCE(i.height, 0) AS height,
              a.filename AS archive_name, g.code AS game_code
       FROM resource r
       LEFT JOIN archive a ON a.id = r.archive_id
       LEFT JOIN game g ON g.id = r.game_id
       LEFT JOIN asset_image i ON i.resource_id = r.id
       ${where}
       ORDER BY r.id`,
    )
    .all(...params) as Row[];

  if (rows.length === 0) {
    console.log('  没有可处理的素材\n');
    return;
  }

  const update = db.prepare('UPDATE resource SET category = ?, role = ? WHERE id = ?');

  // 变更统计：category 与 role 分别计数
  const catMoves = new Map<string, number>();
  const roleMoves = new Map<string, number>();
  const roleAfter = new Map<string, number>();
  const catAfter = new Map<string, number>();
  let changed = 0;

  const apply = db.transaction(() => {
    for (const r of rows) {
      // 图集是流水线派生资源（由精灵打包而成），类别在生成时已确定，
      // 不属于「按条目名判定」的范畴，跳过以免被规则误改
      if (r.category === 'sheet') continue;

      // 条目名可能带 #spriteId 后缀（ANM 内部精灵），归档名参与关键词判定
      const cls = classifyEntry({
        entryName: r.entry_name,
        archiveName: r.archive_name ?? '',
        magic: magicFromExt(r.ext),
        width: r.width,
        height: r.height,
        fromAnm: r.entry_name.includes('#'),
        // 传作品代码，让该版本的专属命名规则参与判定
        gameCode: r.game_code ?? undefined,
      });

      const catChanged = cls.category !== r.category;
      const roleChanged = cls.role !== r.role;

      if (catChanged) {
        catMoves.set(`${r.category} → ${cls.category}`, (catMoves.get(`${r.category} → ${cls.category}`) ?? 0) + 1);
      }
      if (roleChanged) {
        roleMoves.set(`${r.role} → ${cls.role}`, (roleMoves.get(`${r.role} → ${cls.role}`) ?? 0) + 1);
      }
      if (catChanged || roleChanged) {
        changed++;
        if (!DRY) update.run(cls.category, cls.role, r.id);
      }
      roleAfter.set(cls.role, (roleAfter.get(cls.role) ?? 0) + 1);
      catAfter.set(cls.category, (catAfter.get(cls.category) ?? 0) + 1);
    }
  });
  apply();

  // ------------------------------------------------------------ 输出
  console.log(`  扫描素材    ${rows.length} 项${GAME ? `（作品 ${GAME}）` : ''}`);
  console.log(`  需要更新    ${changed} 项${DRY ? '（试运行，未写入）' : ''}`);

  if (catMoves.size > 0) {
    console.log('\n  分类变更:');
    for (const [k, n] of [...catMoves.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`    ${k.padEnd(30)} ${n}`);
    }
  }
  if (roleMoves.size > 0) {
    console.log('\n  用途变更:');
    for (const [k, n] of [...roleMoves.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`    ${k.padEnd(30)} ${n}`);
    }
  }

  console.log('\n  重新分类后的用途分布:');
  for (const [role, n] of [...roleAfter.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${(ROLE_LABELS[role] ?? role).padEnd(16)} ${String(n).padStart(4)}`);
  }

  console.log('\n  重新分类后的分类分布:');
  for (const [cat, n] of [...catAfter.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${cat.padEnd(16)} ${String(n).padStart(4)}`);
  }

  // 未分类样本：用于判断还缺哪些命名模式
  if (has('--show-unknown')) {
    const unknown = rows.filter((r) => classifyEntry({
      entryName: r.entry_name,
      archiveName: r.archive_name ?? '',
      magic: magicFromExt(r.ext),
      width: r.width,
      height: r.height,
      fromAnm: r.entry_name.includes('#'),
      gameCode: r.game_code ?? undefined,
    }).role === 'unknown');

    const byName = new Map<string, number>();
    for (const r of unknown) {
      const key = r.entry_name.replace(/#.*$/, '');
      byName.set(key, (byName.get(key) ?? 0) + 1);
    }
    console.log(`\n  未分类来源（按条目名聚合，共 ${byName.size} 种 / ${unknown.length} 项）:`);
    for (const [name, n] of [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
      const cat = unknown.find((u) => u.entry_name.replace(/#.*$/, '') === name)?.ext ?? '';
      console.log(`    ${name.padEnd(30)} ${String(n).padStart(3)}  ${cat}`);
    }
  }
  console.log('');
}

main();
