/**
 * 强制重新解包（绕过 SHA256 缓存跳过）。
 *
 * 解包默认按归档 SHA256 比对，未变化的归档会直接跳过 —— 这在文件没变时是优点，
 * 但**解析器代码改进后**就会失效：归档没变，新逻辑却跑不到，
 * 表现为"解包完成但 0 项素材"，而数据库里还是旧产物。
 *
 * 用法：
 *   npx tsx src/scripts/reimport.ts                # 重新解包全部已注册作品
 *   npx tsx src/scripts/reimport.ts --game TH06    # 只处理指定作品
 */
import fs from 'node:fs';
import { extractGame, DEFAULT_MODES } from '../services/extractor.ts';
import { db } from '../db/index.ts';

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
};

const GAME = opt('--game');

async function main() {
  const sql = GAME
    ? `SELECT g.code, a.file_path FROM archive a JOIN game g ON g.id = a.game_id WHERE g.code = ? ORDER BY a.id`
    : `SELECT g.code, a.file_path FROM archive a JOIN game g ON g.id = a.game_id ORDER BY g.id, a.id`;
  const rows = (GAME ? db.prepare(sql).all(GAME) : db.prepare(sql).all()) as Array<{
    code: string;
    file_path: string;
  }>;

  if (rows.length === 0) {
    console.log('\n  没有已注册的归档，先扫描游戏目录\n');
    return;
  }

  const byGame = new Map<string, string[]>();
  for (const r of rows) {
    if (!fs.existsSync(r.file_path)) {
      console.log(`  跳过（文件不存在）：${r.file_path}`);
      continue;
    }
    if (!byGame.has(r.code)) byGame.set(r.code, []);
    byGame.get(r.code)!.push(r.file_path);
  }

  console.log(`\n  强制重新解包：${byGame.size} 个作品\n`);

  for (const [code, files] of byGame) {
    console.log(`  ── ${code}（${files.length} 个归档）`);
    const summary = await extractGame({ gameId: code, datFiles: files, modes: DEFAULT_MODES, force: true });
    const shown = Object.entries(summary).filter(([k]) => k !== 'warnings');
    console.log('    ' + shown.map(([k, v]) => `${k}=${v}`).join('  '));
    const w = summary.warnings ?? [];
    if (w.length > 0) {
      console.log(`    提示 ${w.length} 条，前 5 条：`);
      for (const x of w.slice(0, 5)) console.log('     ·', x.slice(0, 150));
    }
  }
  console.log('');
}

main().catch((err) => {
  console.error('重新解包失败：', err);
  process.exit(1);
});
