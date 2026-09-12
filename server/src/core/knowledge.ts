/**
 * 外部作品知识库。
 *
 * 立绘文件编号（face03 / player00）在不同版本间**并不稳定**——thcrap 等
 * 汉化/重打包流程会重排编号，因此不能用编号硬编码角色名。
 *
 * 真正稳定的锚点是**符卡名**：`氷符「アイシクルフォール」` 只可能属于琪露诺。
 * 本模块据此建立「符卡 → 角色 → 关卡」的映射，用于自动识别角色身份。
 *
 * 数据来源：东方 Project 官方游戏数据整理的公开资料
 *   - 东方 Wiki：https://en.touhouwiki.net/wiki/Embodiment_of_Scarlet_Devil
 *   - THBWiki：https://thbwiki.cc/东方红魔乡
 *   - 符卡日文名为游戏内原文，可直接与解包结果比对
 */

export interface CharacterKnowledge {
  key: string;
  name: string;
  nameJp: string;
  nameEn: string;
  title: string;
  type: 'PLAYER' | 'BOSS' | 'ENEMY' | 'EX_BOSS';
  /** 出场关卡（自机为 null） */
  stage: number | null;
  /** 符卡名特征词（日文原文片段），用于反查角色 */
  spellSignatures: string[];
  /** 维基词条（供界面跳转核对） */
  wiki: string;
}

export const TOUHOU_WIKI_BASE = 'https://thbwiki.cc/';

/** 东方红魔乡角色表 */
export const TH06_ROSTER: CharacterKnowledge[] = [
  {
    key: 'reimu',
    name: '博丽灵梦',
    nameJp: '博麗霊夢',
    nameEn: 'Reimu Hakurei',
    title: '楽園の素敵な巫女',
    type: 'PLAYER',
    stage: null,
    spellSignatures: ['夢想封印', '夢符', '霊符', '結界'],
    wiki: '博丽灵梦',
  },
  {
    key: 'marisa',
    name: '雾雨魔理沙',
    nameJp: '霧雨魔理沙',
    nameEn: 'Marisa Kirisame',
    title: '普通の魔法使い',
    type: 'PLAYER',
    stage: null,
    spellSignatures: ['マスタースパーク', '恋符', '魔砲', 'スターダスト'],
    wiki: '雾雨魔理沙',
  },
  {
    key: 'rumia',
    name: '露米娅',
    nameJp: 'ルーミア',
    nameEn: 'Rumia',
    title: '宵闇の妖怪',
    type: 'BOSS',
    stage: 1,
    spellSignatures: ['ムーンライトレイ', 'ナイトバード', 'ディマーケイション'],
    wiki: '露米娅',
  },
  {
    key: 'daiyousei',
    name: '大妖精',
    nameJp: '大妖精',
    nameEn: 'Daiyousei',
    title: '小さな妖精',
    type: 'ENEMY',
    stage: 2,
    spellSignatures: [],
    wiki: '大妖精',
  },
  {
    key: 'cirno',
    name: '琪露诺',
    nameJp: 'チルノ',
    nameEn: 'Cirno',
    title: '湖上の氷精',
    type: 'BOSS',
    stage: 2,
    spellSignatures: ['アイシクルフォール', 'ヘイルストーム', 'パーフェクトフリーズ', 'ダイアモンドブリザード', 'アイシクルマシンガン'],
    wiki: '琪露诺',
  },
  {
    key: 'meiling',
    name: '红美铃',
    nameJp: '紅美鈴',
    nameEn: 'Hong Meiling',
    title: '華人少女',
    type: 'BOSS',
    stage: 3,
    spellSignatures: ['芳華絢爛', 'セラギネラ', '彩虹の風鈴', '華想夢葛', '彩雨', '彩光乱舞', '極彩颱風'],
    wiki: '红美铃',
  },
  {
    key: 'koakuma',
    name: '小恶魔',
    nameJp: '小悪魔',
    nameEn: 'Koakuma',
    title: '知識と日陰の少女',
    type: 'ENEMY',
    stage: 4,
    spellSignatures: [],
    wiki: '小恶魔',
  },
  {
    key: 'patchouli',
    name: '帕秋莉·诺蕾姬',
    nameJp: 'パチュリー・ノーレッジ',
    nameEn: 'Patchouli Knowledge',
    title: '知識と日陰の少女',
    type: 'BOSS',
    stage: 4,
    spellSignatures: ['アグニシャイン', 'アグニレイディアンス', 'プリンセスウンディネ', 'ベリーインレイク', 'シルフィホルン', 'シルバードライブ', 'トリリトン', 'ロイヤルフレア', 'サイレントセレナ', '賢者の石'],
    wiki: '帕秋莉·诺蕾姬',
  },
  {
    key: 'sakuya',
    name: '十六夜咲夜',
    nameJp: '十六夜咲夜',
    nameEn: 'Sakuya Izayoi',
    title: '紅魔館のメイド',
    type: 'BOSS',
    stage: 5,
    spellSignatures: ['ミスディレクション', 'クロックコープス', 'ルナクロック', '操りドール', 'シルバーバウンド', 'プライベートスクウェア', 'ミステリアスジャック', 'インスクライブレッドソウル'],
    wiki: '十六夜咲夜',
  },
  {
    key: 'remilia',
    name: '蕾米莉亚·斯卡雷特',
    nameJp: 'レミリア・スカーレット',
    nameEn: 'Remilia Scarlet',
    title: '永遠に紅い幼き月',
    type: 'BOSS',
    stage: 6,
    spellSignatures: ['スカーレットシュート', 'スカーレットマイスタ', 'スカーレットデビル', 'デーモンロード', '紅色の冥界', '千本の針の山', 'フィンガーナイフ', 'ハートブレイク', 'グングニル'],
    wiki: '蕾米莉亚·斯卡雷特',
  },
  {
    key: 'flandre',
    name: '芙兰朵露·斯卡雷特',
    nameJp: 'フランドール・スカーレット',
    nameEn: 'Flandre Scarlet',
    title: '悪魔の妹',
    type: 'EX_BOSS',
    stage: 7,
    spellSignatures: ['クランベリートラップ', 'レーヴァテイン', 'スターボウブレイク', '誰もいなくなるか', '495年の波紋', 'フォーオブアカインド'],
    wiki: '芙兰朵露·斯卡雷特',
  },
];

/** 各作品的角色名单 */
export const ROSTER_BY_GAME: Record<string, CharacterKnowledge[]> = {
  TH06: TH06_ROSTER,
};

export function rosterOf(gameCode: string): CharacterKnowledge[] {
  return ROSTER_BY_GAME[gameCode.toUpperCase()] ?? [];
}

/**
 * 符卡属性前缀表。
 *
 * TH06 的符卡命名规律是「属性符「名称」」，属性词与角色的对应关系稳定。
 * 用前缀匹配可以覆盖完整符卡表，而不必逐张列举名称。
 *
 * 唯一冲突是「月符」同时属于露米娅与帕秋莉，因此这两条用更长的前缀区分。
 */
const SPELL_PREFIX_MAP: Array<{ prefixes: string[]; key: string }> = [
  { prefixes: ['月符「ムーンライト', '夜符', '闇符'], key: 'rumia' },
  { prefixes: ['氷符', '雹符', '凍符', '雪符'], key: 'cirno' },
  { prefixes: ['華符', '虹符', '幻符', '彩符'], key: 'meiling' },
  {
    prefixes: ['火符', '水符', '木符', '金符', '土符', '日符', '月符「サイレント', '火＆土符', '火水木金土符'],
    key: 'patchouli',
  },
  { prefixes: ['奇術', '幻在', '幻象', '銀符', '時符', '傷符', 'メイド秘技'], key: 'sakuya' },
  { prefixes: ['紅符', '紅霧', '神罰', '冥符', '獄符', '呪詛', '紅魔', '必殺', '神槍'], key: 'remilia' },
  { prefixes: ['禁忌', '禁弾', '秘弾', 'QED'], key: 'flandre' },
  { prefixes: ['夢符', '霊符', '夢想封印', '結界', '封魔'], key: 'reimu' },
  { prefixes: ['恋符', '魔砲', 'マスタースパーク', 'スターダスト'], key: 'marisa' },
];

/**
 * 用符卡名反查角色。
 * 优先按属性前缀匹配（覆盖完整），其次按名称特征词（兜底）。
 */
export function identifyBySpell(spellName: string, gameCode: string): { character: CharacterKnowledge; hits: number } | null {
  const roster = rosterOf(gameCode);
  const byKey = new Map(roster.map((c) => [c.key, c]));

  // 1. 属性前缀优先
  for (const entry of SPELL_PREFIX_MAP) {
    if (!entry.prefixes.some((p) => spellName.includes(p))) continue;
    const c = byKey.get(entry.key);
    // 前缀命中的置信度更高，返回一个较大的 hits 值
    if (c) return { character: c, hits: 10 };
  }

  // 2. 名称特征词兜底
  let best: { character: CharacterKnowledge; hits: number } | null = null;
  for (const c of roster) {
    let hits = 0;
    for (const sig of c.spellSignatures) {
      if (spellName.includes(sig)) hits++;
    }
    if (hits > 0 && (!best || hits > best.hits)) best = { character: c, hits };
  }
  return best;
}

export function wikiUrl(character: CharacterKnowledge): string {
  return `${TOUHOU_WIKI_BASE}${encodeURIComponent(character.wiki)}`;
}
