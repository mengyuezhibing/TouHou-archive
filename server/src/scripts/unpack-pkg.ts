/**
 * TH06NC PKGL 归档解包工具
 *
 * 用法：
 *   tsx src/scripts/unpack-pkg.ts <归档.dat 或 目录> [选项]
 *
 * 选项：
 *   -o, --out <目录>     导出目录（默认 ./unpacked）
 *   -l, --list           只列出条目，不导出
 *   -f, --filter <正则>  只处理名字匹配的条目
 *   -v, --verify         导出后校验解压大小与索引声明是否一致
 *       --no-decompress  只解密，不做 zstd 解压（用于排查）
 *   -h, --help           显示帮助
 *
 * 示例：
 *   tsx src/scripts/unpack-pkg.ts "th06nc/data"           # 解全部 7 个归档
 *   tsx src/scripts/unpack-pkg.ts "th06nc/data/th06ST.dat" -l
 *   tsx src/scripts/unpack-pkg.ts "th06ST.dat" -f '\.ecl$' -o ./ecl
 */
import fs from 'node:fs';
import path from 'node:path';
import { PkgArchive, type PkgEntry } from '../formats/pkg.ts';

interface Options {
  input: string;
  out: string;
  list: boolean;
  filter: RegExp | null;
  verify: boolean;
  decompress: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    input: '',
    out: './unpacked',
    list: false,
    filter: null,
    verify: false,
    decompress: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-o':
      case '--out':
        opts.out = argv[++i];
        break;
      case '-l':
      case '--list':
        opts.list = true;
        break;
      case '-f':
      case '--filter':
        opts.filter = new RegExp(argv[++i], 'i');
        break;
      case '-v':
      case '--verify':
        opts.verify = true;
        break;
      case '--no-decompress':
        opts.decompress = false;
        break;
      case '-h':
      case '--help':
        console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
        process.exit(0);
        break;
      default:
        if (!opts.input) opts.input = a;
        else throw new Error(`未知参数：${a}`);
    }
  }
  if (!opts.input) throw new Error('缺少输入路径。用 --help 查看用法。');
  return opts;
}

function human(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 归档内的名字理论上可直接当相对路径用，但仍要挡掉目录穿越
 * （`../`、绝对路径、盘符），避免恶意归档写到输出目录之外。
 */
function safeRelative(name: string): string | null {
  const norm = name.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm) return null;
  const parts = norm.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  if (/^[a-zA-Z]:/.test(parts[0] ?? '')) return null;
  const rel = parts.join('/');
  return rel.length > 0 ? rel : null;
}

function collectArchives(input: string): string[] {
  const st = fs.statSync(input);
  if (st.isFile()) return [input];
  return fs
    .readdirSync(input)
    .filter((f) => f.toLowerCase().endsWith('.dat'))
    .sort()
    .map((f) => path.join(input, f));
}

function unpackOne(archivePath: string, opts: Options, totals: { files: number; bytes: number; failed: number }): void {
  const stem = path.basename(archivePath, path.extname(archivePath));
  const archive = PkgArchive.open(archivePath);
  try {
    const matched = opts.filter ? archive.entries.filter((e) => opts.filter!.test(e.name)) : archive.entries;
    console.log(
      `\n  ${path.basename(archivePath)}  —  ${archive.entries.length} 条目` +
        (opts.filter ? `（匹配 ${matched.length}）` : ''),
    );

    if (opts.list) {
      for (const e of matched) {
        const tag = e.flags & 1 ? 'zstd' : 'raw ';
        const ratio = e.originalSize > 0 ? `${((e.storedSize / e.originalSize) * 100).toFixed(0)}%` : '—';
        console.log(
          `    ${tag}  ${human(e.originalSize).padStart(9)} → ${human(e.storedSize).padStart(9)} (${ratio.padStart(4)})  ${e.name}`,
        );
      }
      return;
    }

    for (const entry of matched) {
      const rel = safeRelative(entry.name);
      if (!rel) {
        console.warn(`    ! 跳过可疑名字：${entry.name}`);
        totals.failed++;
        continue;
      }
      try {
        const data = archive.read(entry, !opts.decompress);
        if (opts.verify && opts.decompress && data.length !== entry.originalSize) {
          throw new Error(`大小不符：得到 ${data.length}，索引声明 ${entry.originalSize}`);
        }
        const dest = path.join(opts.out, stem, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, data);
        totals.files++;
        totals.bytes += data.length;
      } catch (err) {
        totals.failed++;
        console.error(`    ! ${entry.name}: ${(err as Error).message}`);
      }
    }
    console.log(`    已导出 ${matched.length} 个条目 → ${path.join(opts.out, stem)}`);
  } finally {
    archive.close();
  }
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const archives = collectArchives(opts.input);
  if (archives.length === 0) {
    console.error('  未找到任何 .dat 归档');
    process.exit(1);
  }

  console.log(`  输入    ${path.resolve(opts.input)}`);
  if (!opts.list) console.log(`  输出    ${path.resolve(opts.out)}`);
  console.log(`  归档数  ${archives.length}`);

  const t0 = Date.now();
  const totals = { files: 0, bytes: 0, failed: 0 };
  for (const a of archives) {
    try {
      unpackOne(a, opts, totals);
    } catch (err) {
      totals.failed++;
      console.error(`\n  ✗ ${path.basename(a)}: ${(err as Error).message}`);
    }
  }

  if (!opts.list) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n  完成：${totals.files} 个文件，${human(totals.bytes)}，用时 ${secs}s`);
    if (totals.failed > 0) console.log(`  失败 ${totals.failed} 个`);
  }
}

main();
