/**
 * 破解 New Classic 的 edz 载荷。
 *
 * 背景：重制版（TH06 Classic / New Classic）把部分条目包成 `edz` + 密文，
 * 结构比 TH08/09 的「edz + 类型码 + 密文」简单 —— 第 4 字节起就是密文本身。
 * 既然没有类型码，就说明它用的可能是**某一套固定的 crypt 参数**，
 * 因此可以拿历代作品已知的参数表去穷举，以「解出可识别魔数」为成功判据。
 *
 * 用法：npx tsx src/scripts/crack-edz.ts [--game TH06NC]
 */
import fs from 'node:fs';
import { db } from '../db/index.ts';
import { parseDat, sliceEntry } from '../formats/dat.ts';
import {
  TH08_CRYPT_PARAMS,
  TH09_CRYPT_PARAMS,
  TH95_CRYPT_PARAMS,
  TH12_CRYPT_PARAMS,
  TH13_CRYPT_PARAMS,
  thDecrypt,
  type CryptParams,
} from '../core/crypt.ts';
import { detectMagic } from '../core/magic.ts';

const argv = process.argv.slice(2);
const opt = (n: string, d?: string) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const GAME = opt('--game', 'TH06NC');

/** 候选参数：把历代已知表全部展开，带上来源名便于回溯 */
const CANDIDATES: Array<{ label: string; params: CryptParams }> = [
  ...TH08_CRYPT_PARAMS.map((p) => ({ label: `TH08:${p.type}`, params: p })),
  ...TH09_CRYPT_PARAMS.map((p) => ({ label: `TH09:${p.type}`, params: p })),
  ...TH95_CRYPT_PARAMS.map((p, i) => ({ label: `TH95:${i}`, params: p })),
  ...TH12_CRYPT_PARAMS.map((p, i) => ({ label: `TH12:${i}`, params: p })),
    ...TH13_CRYPT_PARAMS.map((p, i) => ({ label: `TH13:${i}`, params: p })),
  // 在 th06nc.exe 里扫到的四元组（可能是新版参数表）
  { label: 'exe@0x307868', params: { key: 0x80, step: 0x100, block: 0x200, limit: 0x400 } },
];

/** 解密成功的判据：头部呈现已知文件特征 */
function looksDecrypted(buf: Buffer): string | null {
  if (buf.length < 4) return null;
  const m = detectMagic(buf.subarray(0, 32));
  if (m && m.kind !== 'binary' && m.kind !== 'text') return m.kind;
  // ECL：头部结构固定为 sub_count / main_offset / 0 / 0，两个 padding 必须为 0
  if (buf.length >= 16) {
    const subCount = buf.readUInt32LE(0);
    const mainOffset = buf.readUInt32LE(4);
    const p2 = buf.readUInt32LE(8);
    const p3 = buf.readUInt32LE(12);
    if (subCount > 0 && subCount < 4096 && mainOffset > 16 && mainOffset < buf.length && p2 === 0 && p3 === 0) {
      return 'ecl(结构自洽)';
    }
  }
  return null;
}

async function main() {
  const gid = (db.prepare('SELECT id FROM game WHERE code = ?').get(GAME) as any)?.id;
  if (!gid) {
    console.log(`\n  未找到作品 ${GAME}\n`);
    return;
  }
  const archives = db
    .prepare('SELECT filename, file_path FROM archive WHERE game_id = ? ORDER BY filename')
    .all(gid) as Array<{ filename: string; file_path: string }>;

  console.log(`\n  破解 ${GAME} 的 edz 载荷`);
  console.log(`  候选参数 ${CANDIDATES.length} 组\n`);

  // 收集 edz 样本
  const samples: Array<{ archive: string; name: string; raw: Buffer }> = [];
  for (const ar of archives) {
    if (!fs.existsSync(ar.file_path)) continue;
    const buf = fs.readFileSync(ar.file_path);
    const parsed = parseDat(buf, { gameId: GAME });
    for (const e of parsed.entries) {
      const raw = sliceEntry(buf, e);
      if (raw.length >= 16 && raw.toString('latin1', 0, 3) === 'edz') {
        samples.push({ archive: ar.filename, name: e.name, raw });
        if (samples.length >= 12) break;
      }
    }
    if (samples.length >= 12) break;
  }

  console.log(`  取样 ${samples.length} 条 edz 条目\n`);
  if (samples.length === 0) return;

  // 逐条 × 逐参数 × 逐个头部长度 尝试
  for (const headLen of [3, 4]) {
    for (const cand of CANDIDATES) {
      let hits = 0;
      let firstHit = '';
      for (const s of samples) {
        const payload = Buffer.from(s.raw.subarray(headLen));
        try {
          thDecrypt(payload, cand.params);
        } catch {
          continue;
        }
        const kind = looksDecrypted(payload);
        if (kind) {
          hits++;
          if (!firstHit) firstHit = `${s.archive}/${s.name} → ${kind}`;
        }
      }
      if (hits > 0) {
        console.log(`  ★ 命中 ${hits}/${samples.length}  ${cand.label}  headLen=${headLen}`);
        console.log(`      ${firstHit}`);
        console.log(
          `      参数 key=0x${cand.params.key.toString(16)} step=0x${cand.params.step.toString(16)} ` +
            `block=0x${cand.params.block.toString(16)} limit=0x${cand.params.limit.toString(16)}`,
        );
      }
    }
  }

  console.log('\n  扫描完成（无输出即表示全部候选参数都不成立）\n');
}

main();
