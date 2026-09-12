import fs from 'node:fs';
import { db } from '../db/index.ts';
import { decodePng } from '../core/png.ts';

/** 快速自检：验证数据库各表与产物文件的一致性 */

const one = (sql: string) => (db.prepare(sql).get() as any).c as number;

console.log('\n=== 作品 ===');
for (const g of db.prepare('SELECT code, name, status FROM game').all() as any[]) {
  console.log(`  ${g.code}  ${g.name}  [${g.status}]`);
}

console.log('\n=== 表记录数 ===');
const tables: Array<[string, string]> = [
  ['Game 作品', 'SELECT COUNT(*) c FROM game'],
  ['Archive 归档', 'SELECT COUNT(*) c FROM archive'],
  ['Resource 素材', 'SELECT COUNT(*) c FROM resource'],
  ['Asset_Image 图片', 'SELECT COUNT(*) c FROM asset_image'],
  ['Animation 动画', 'SELECT COUNT(*) c FROM animation'],
  ['Animation_Frame 帧', 'SELECT COUNT(*) c FROM animation_frame'],
  ['Character 角色', 'SELECT COUNT(*) c FROM character'],
  ['Character_Asset 关联', 'SELECT COUNT(*) c FROM character_asset'],
  ['Enemy 敌人', 'SELECT COUNT(*) c FROM enemy'],
  ['Bullet_Pattern 弹幕', 'SELECT COUNT(*) c FROM bullet_pattern'],
  ['Bullet_Action 动作', 'SELECT COUNT(*) c FROM bullet_action'],
  ['SpellCard 符卡', 'SELECT COUNT(*) c FROM spell_card'],
  ['Music 音乐', 'SELECT COUNT(*) c FROM music'],
  ['Dialogue 文本', 'SELECT COUNT(*) c FROM dialogue'],
  ['Tag 标签', 'SELECT COUNT(*) c FROM tag'],
  ['Resource_Tag 标签关联', 'SELECT COUNT(*) c FROM resource_tag'],
];
for (const [label, sql] of tables) {
  console.log(`  ${label.padEnd(22)} ${String(one(sql)).padStart(6)}`);
}

console.log('\n=== 素材分类 ===');
for (const s of db.prepare('SELECT category, COUNT(*) c, SUM(size) s FROM resource GROUP BY category ORDER BY c DESC').all() as any[]) {
  console.log(`  ${String(s.category).padEnd(12)} ${String(s.c).padStart(5)} 项  ${(s.s / 1024).toFixed(1)} KB`);
}

console.log('\n=== 素材类型（文档 resource_type 枚举）===');
for (const s of db.prepare('SELECT resource_type, COUNT(*) c FROM resource GROUP BY resource_type ORDER BY c DESC').all() as any[]) {
  console.log(`  ${String(s.resource_type).padEnd(12)} ${String(s.c).padStart(5)}`);
}

// 文件校验
const checks: string[] = [];
const assets = db.prepare("SELECT code, path, (SELECT width FROM asset_image ai WHERE ai.resource_id = r.id) AS width FROM resource r WHERE path IS NOT NULL").all() as any[];
for (const a of assets) {
  if (!a.path) continue;
  if (!fs.existsSync(a.path)) {
    checks.push(`缺失文件: ${a.code} -> ${a.path}`);
    continue;
  }
  if (a.path.endsWith('.png')) {
    const img = decodePng(fs.readFileSync(a.path));
    if (!img) checks.push(`PNG 解码失败: ${a.code}`);
    else if (a.width && img.width !== a.width) checks.push(`尺寸不符: ${a.code} db=${a.width} file=${img.width}`);
  }
}
console.log(`\n=== 文件校验（${assets.length} 个缓存文件）===`);
console.log(checks.length === 0 ? '  全部通过 ✓' : checks.slice(0, 20).map((c) => `  ✗ ${c}`).join('\n'));

console.log('\n=== 精灵图集 ===');
for (const s of db.prepare("SELECT display_name, meta, (SELECT width FROM asset_image ai WHERE ai.resource_id = r.id) AS w, (SELECT height FROM asset_image ai WHERE ai.resource_id = r.id) AS h FROM resource r WHERE category = 'sheet'").all() as any[]) {
  const m = JSON.parse(s.meta || '{}');
  console.log(`  ${s.display_name}  ${s.w}x${s.h}  ${m.frameCount} 帧${m.overflow ? `  溢出 ${m.overflow}` : ''}`);
}

console.log('\n=== 动画（Animation / Animation_Frame）===');
for (const a of db.prepare(`
  SELECT a.name, a.frame_count, a.fps, a.loop, r.code AS res_code,
         (SELECT COUNT(*) FROM animation_frame f WHERE f.animation_id = a.id) AS frames
  FROM animation a LEFT JOIN resource r ON r.id = a.resource_id LIMIT 10
`).all() as any[]) {
  console.log(`  ${a.name}  ${a.frames}/${a.frame_count} 帧  ${a.fps}fps  ${a.loop ? '循环' : '单次'}  ← ${a.res_code}`);
}

console.log('\n=== 音乐 ===');
for (const b of db.prepare('SELECT title, codec, size, path FROM music ORDER BY index_num').all() as any[]) {
  console.log(`  ${b.title}  [${b.codec}]  ${(b.size / 1024).toFixed(1)} KB  ${b.path ? '✓ 已导出' : '未导出'}`);
}

console.log('\n=== 对话样例（含说话人提取）===');
for (const m of db.prepare('SELECT speaker, text FROM dialogue LIMIT 5').all() as any[]) {
  console.log(`  ${(m.speaker ?? '（旁白）').padEnd(8)} ${m.text}`);
}

console.log('\n=== 弹幕模式与动作时间轴 ===');
for (const p of db.prepare(`
  SELECT bp.code, bp.type, bp.note,
         (SELECT COUNT(*) FROM bullet_action ba WHERE ba.pattern_id = bp.id) AS actions
  FROM bullet_pattern bp LIMIT 5
`).all() as any[]) {
  console.log(`  [${p.type}] ${p.code}  ${p.actions} 个动作`);
  console.log(`      ${p.note}`);
}
for (const a of db.prepare('SELECT time, action_type, parameter FROM bullet_action ORDER BY time LIMIT 4').all() as any[]) {
  const p = JSON.parse(a.parameter || '{}');
  console.log(`      t=${a.time}s ${a.action_type}  弹数${p.count} 速度${p.speed} 角度${p.angle}`);
}

console.log('\n=== 角色与素材关联 ===');
for (const c of db.prepare(`
  SELECT ch.name, ch.type, ch.sprite_count, ch.colors,
         (SELECT COUNT(*) FROM character_asset ca WHERE ca.character_id = ch.id) AS linked
  FROM character ch
`).all() as any[]) {
  console.log(`  ${c.name}  [${c.type}]  ${c.sprite_count} 精灵  关联 ${c.linked}  颜色: ${JSON.parse(c.colors || '[]').join('/')}`);
}

console.log('\n=== 标签使用排行 ===');
for (const t of db.prepare(`
  SELECT t.name, COUNT(*) c FROM resource_tag rt JOIN tag t ON t.id = rt.tag_id
  GROUP BY t.id ORDER BY c DESC LIMIT 10
`).all() as any[]) {
  console.log(`  ${t.name.padEnd(14)} ${String(t.c).padStart(5)}`);
}

console.log('');
