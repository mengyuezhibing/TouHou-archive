import type { MagicInfo } from '../core/magic.ts';

/**
 * 素材分类与角色归类（对应设计文档第六、七、八节）。
 * 采用"规则 + 关键词 + 尺寸特征"的启发式判定，不确定的结果保留 unknown 以便人工修正。
 */

export interface Classification {
  kind: string;
  category: string;
  role: string;
  tags: string[];
}

interface Rule {
  test: RegExp;
  category: string;
  role?: string;
  tags: string[];
  /** 当条目名以这些扩展名结尾时跳过该规则（例如 music.anm 是界面动画而非音频） */
  skipExt?: string[];
}

/**
 * 按条目名匹配的分类规则（顺序敏感，越靠前优先级越高）。
 *
 * role 表示「用途」，必须是可用作界面筛选项的有限集合；
 * category 表示「是什么」，描述素材本身的形态。两者是两个维度，
 * 不能混用（音频的 category 是 audio，用途上它属于「音效」而非 ui）。
 */
const NAME_RULES: Rule[] = [
  // 敌机贴图：红魔乡系把敌机图集命名为 stgNenm.anm（enm = enemy），
  // 只写 enemy 会漏掉全部敌机素材，必须把 enm 缩写纳入关键词。
  { test: /enm|enemy|zako|fairy/i, category: 'character', role: 'enemy', tags: ['敌机'] },
  { test: /\bboss\b|spell_?card|spellcard/i, category: 'character', role: 'boss', tags: ['Boss'] },
  { test: /etama|bullet|(^|[^a-z])tama\d*(?![a-z])|shot_?type|danmaku/i, category: 'bullet', role: 'bullet', tags: ['子弹', '弹幕素材'] },
  { test: /laser|beam/i, category: 'bullet', role: 'bullet', tags: ['激光'] },
  // eff01 / eff02 … 是特效贴图；\beff\b 匹配不到它们（字母与数字间无词边界）
  { test: /(^|[^a-z])eff(ect)?\d*(?![a-z])|effect\./i, category: 'effect', role: 'effect', tags: ['特效'] },
  { test: /face|portrait|cutin|\bkao\b|chara_?select/i, category: 'portrait', role: 'portrait', tags: ['立绘', '头像'] },
  { test: /player|reimu|marisa|sakuya|youmu|sanae|cirno|aya|reisen/i, category: 'character', role: 'player', tags: ['自机'] },
  { test: /\.msg$|^msg\d*\.(dat|msg)$|^msg\d+$/i, category: 'text', role: 'unknown', tags: ['剧情文本'] },
  { test: /ecldata|\.ecl$|^ecl$/i, category: 'script', role: 'unknown', tags: ['敌机脚本'] },
  { test: /\.std$|\.sht$|stage\d*\.std/i, category: 'script', role: 'unknown', tags: ['关卡脚本'] },
  { test: /item|point|power|star_?item|spell_?item|full_?power/i, category: 'item', role: 'item', tags: ['道具'] },
  // music00.png / bgm 是音乐室的界面贴图，不是音频本身。
  // 因此 UI 规则要先于音频规则，并用 skipExt 把真正的音频文件让给下面的音频规则。
  {
    // end00~end13 是结局演出 CG；capture / text 是截图与文本显示界面。
    // end 用「行首或非字母 + end + 数字」限定，避免误伤 legend / weekend 这类词。
    test: /music|bgm|title_?demo|ascii|font|outline|menu|title|logo|load|gameover|cursor|window|number|hud|score|staff|ending|result|best|ranking|select|front|replay|slpl|demo|capture|(^|[^a-z])end\d*(?![a-z])|(^|[^a-z])text(?![a-z])/i,
    category: 'ui',
    role: 'ui',
    tags: ['界面'],
    skipExt: ['.wav', '.ogg', '.mid', '.midi', '.mp3', '.m4a'],
  },
  // 注意：\bbg\b 匹配不到 stg1bg —— 数字与字母之间不构成词边界，
  // 所以这里显式允许「非字母 + bg + 数字」的形式。
  {
    test: /stage|background|(^|[^a-z])bg\d*(?![a-z])|map|tile|grass|tree|cave|sky|cloud/i,
    category: 'background',
    role: 'background',
    tags: ['背景'],
  },
  {
    test: /music|bgm|sound|se_|_se\b|voice|title_?demo|\.wav$|\.ogg$|\.mid$/i,
    category: 'audio',
    role: 'audio',
    tags: ['音频'],
    skipExt: ['.anm', '.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp', '.txt', '.std'],
  },
  { test: /\.anm$/i, category: 'sprite', role: 'unknown', tags: ['动画贴图'] },
  { test: /\.ecl$/i, category: 'script', role: 'unknown', tags: ['敌机脚本'] },
  { test: /\.msg$/i, category: 'text', role: 'unknown', tags: ['剧情文本'] },
  { test: /\.(std|sht)$/i, category: 'script', role: 'unknown', tags: ['关卡脚本'] },
];

/** 文件名中能直接反映角色身份的关键词（用于角色自动归类） */
export const CHARACTER_HINTS: Record<string, string> = {
  reimu: '博丽灵梦',
  marisa: '雾雨魔理沙',
  sakuya: '十六夜咲夜',
  youmu: '魂魄妖梦',
  remilia: '蕾米莉亚',
  flandre: '芙兰朵露',
  yuyuko: '西行寺幽幽子',
  yukari: '八云紫',
  cirno: '琪露诺',
  letty: '蕾蒂',
  chen: '橙',
  alice: '爱丽丝',
  patchouli: '帕秋莉',
  sanae: '东风谷早苗',
  reisen: '铃仙',
  kaguya: '蓬莱山辉夜',
  eirin: '八意永琳',
  mokou: '藤原妹红',
  suika: '伊吹萃香',
  aya: '射命丸文',
  komachi: '小野冢小町',
  eiki: '四季映姬',
  nitori: '河城荷取',
  momiji: '犬走椛',
  satori: '古明地觉',
  koishi: '古明地恋',
  utsuho: '灵乌路空',
  rin: '火焰猫燐',
  yamame: '黑谷山女',
  parsee: '水桥帕露西',
  yuugi: '星熊勇仪',
  suwako: '洩矢诹访子',
  kanako: '八坂神奈子',
  nazrin: '娜兹玲',
  kogasa: '多多良小伞',
  ichirin: '云居一轮',
  byakuren: '圣白莲',
  murasa: '村纱水蜜',
  shou: '寅丸星',
  nue: '封兽鵺',
  kyouko: '幽谷响子',
  seiga: '霍青娥',
  futo: '物部布都',
  miko: '丰聪耳神子',
  mamizou: '二岩猯藏',
  yoshika: '宫古芳香',
  wakasagi: '若鹭姬',
  seija: '鬼人正邪',
  shinmyoumaru: '少名针妙丸',
  benben: '鬼人正邪',
  yatsuhashi: '九十九八桥',
  raiko: '堀川雷鼓',
  sukuna: '少名针妙丸',
  junko: '纯狐',
  clowpiece: '克劳恩皮丝',
  hecatia: '赫卡提亚',
  doremy: '多莉米',
  sagume: '稀神萨古梅',
  ringo: '铃瑚',
  seiran: '清兰',
  nemuno: '坂田合欢',
  aunn: '高丽野阿吽',
  narumi: '尔子田里乃',
  mai: '丁礼田舞',
  okina: '摩多罗隐岐奈',
  eika: '戎璎花',
  iku: '戎璎花',
  mayumi: '杖刀偶磨弓',
  keiki: '埴安神袿姬',
  kutaka: '庭渡久侘歌',
  yachie: '吉吊八千慧',
  tojiko: '苏我屠自古',
  saki: '骊驹早鬼',
  yuuma: '饕餮尤魔',
  mike: '高丽野阿吽',
  takane: '山城高岭',
  santen: '天火人千亦',
  chimata: '天弓千亦',
  megumu: '饭纲丸龙',
  tsukasa: '姬虫百百世',
  momoyo: '尘冢菫子',
  eika2: '戎璎花',
};

export function detectCharacterHint(entryName: string, archiveName: string): { key: string; name: string } | null {
  const hay = `${entryName} ${archiveName}`.toLowerCase();
  for (const [key, name] of Object.entries(CHARACTER_HINTS)) {
    if (new RegExp(`(^|[^a-z])${key}([^a-z]|$)`, 'i').test(hay)) return { key, name };
  }
  return null;
}

export interface ClassifyInput {
  entryName: string;
  archiveName: string;
  magic: MagicInfo;
  width?: number;
  height?: number;
  /** 是否来自 ANM 内部 sprite */
  fromAnm?: boolean;
}

export function classifyEntry(input: ClassifyInput): Classification {
  const { entryName, archiveName, magic, width = 0, height = 0, fromAnm = false } = input;
  const hay = `${entryName} ${archiveName}`;
  const lowerEntry = entryName.toLowerCase();

  let category = 'unknown';
  let role = 'unknown';
  const tags: string[] = [];

  // 规则同时对「条目名」与「条目名+归档名」求值：
  // 前者保证 ^...$ 锚点可用，后者允许通过归档名线索（如 player00.anm 内的 sprite）参与判定。
  for (const rule of NAME_RULES) {
    if (rule.skipExt?.some((ext) => lowerEntry.endsWith(ext))) continue;
    if (rule.test.test(entryName) || rule.test.test(hay)) {
      category = rule.category;
      role = rule.role ?? 'unknown';
      tags.push(...rule.tags);
      break;
    }
  }

  // 归档内条目本身没有扩展名时，依据魔数兜底
  if (category === 'unknown') {
    if (magic.image) {
      category = fromAnm ? 'sprite' : 'image';
      tags.push('图像');
    } else if (magic.audio) {
      category = 'audio';
      tags.push('音频');
    } else if (magic.text) {
      category = 'text';
      tags.push('文本');
    } else {
      category = 'binary';
    }
  }

  // 尺寸特征补充判定（立绘通常较大，子弹贴图通常很小）
  if (category === 'sprite' || category === 'image') {
    const maxSide = Math.max(width, height);
    if (maxSide >= 160) {
      tags.push('大尺寸');
      if (/portrait|face|cutin/i.test(hay)) category = 'portrait';
    }
    if (maxSide > 0 && maxSide <= 24) tags.push('小尺寸');
  }

  // 角色提示
  const hint = detectCharacterHint(entryName, archiveName);
  if (hint) tags.push(hint.name);

  const kind = fromAnm ? 'image' : magicKindToKind(magic.kind, entryName);

  // 脚本 / 文本 / 二进制数据本身没有「美术用途」，
  // 统一归为 data，避免它们全部压进「未分类」淹没有效信息
  if (role === 'unknown' && ['script', 'text', 'binary'].includes(category)) {
    role = 'data';
  }

  return { kind, category, role, tags: dedupe(tags) };
}

function magicKindToKind(magicKind: string, entryName: string): string {
  const lower = entryName.toLowerCase();
  if (lower.endsWith('.anm')) return 'anm';
  // 归档内条目常无扩展名（红魔乡的敌机脚本就叫 ecldata）
  if (lower.endsWith('.ecl') || /^ecldata/.test(lower)) return 'ecl';
  if (lower.endsWith('.msg') || /^msg\d*\.(dat|msg)$/.test(lower) || /^msg\d+$/.test(lower)) return 'msg';
  if (lower.endsWith('.std') || lower.endsWith('.sht')) return 'std';
  if (magicKind === 'png' || magicKind === 'jpeg' || magicKind === 'bmp' || magicKind === 'gif') return 'image';
  if (magicKind === 'ogg' || magicKind === 'wav' || magicKind === 'mp3' || magicKind === 'midi') return 'audio';
  if (magicKind === 'text') return 'text';
  return 'binary';
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

/** 依据素材集合推断角色实体（对应第七节"角色自动归类"） */
export interface RoleGroup {
  role: string;
  label: string;
  assetIds: string[];
  hint: string;
}

export function groupByRole(assets: Array<{ id: string; entryName: string; category: string; role: string; width: number; height: number }>): RoleGroup[] {
  const groups = new Map<string, { label: string; assetIds: string[] }>();

  for (const a of assets) {
    let role = a.role;
    if (role === 'unknown' || !role) {
      // 尺寸 + 来源推断
      if (a.category === 'bullet' || a.category === 'effect') role = 'effect';
      else if (a.category === 'portrait') role = 'ui';
      else role = 'unknown';
    }
    const label = ROLE_LABELS[role] ?? '未分类';
    const g = groups.get(role) ?? { label, assetIds: [] };
    g.assetIds.push(a.id);
    groups.set(role, g);
  }

  return [...groups.entries()].map(([role, g]) => ({
    role,
    label: g.label,
    assetIds: g.assetIds,
    hint: ROLE_HINTS[role] ?? '',
  }));
}

export const ROLE_LABELS: Record<string, string> = {
  player: 'Player 自机',
  enemy: 'Enemy 敌机',
  boss: 'Boss',
  portrait: '立绘 / 头像',
  bullet: '子弹 / 弹幕',
  effect: 'Effect 特效',
  background: 'Background 背景',
  item: '道具',
  ui: 'UI 界面',
  audio: '音效',
  data: '数据 / 脚本',
  unknown: '未分类',
};

export const ROLE_HINTS: Record<string, string> = {
  player: '判定依据：文件名含 player / 角色名关键词',
  enemy: '判定依据：文件名含 enm（红魔乡系敌机图集缩写）/ enemy / fairy / zako',
  boss: '判定依据：文件名含 boss / spell。注意多数作品的 Boss 与敌机共用图集（如 stg6enm.anm），需人工标注',
  portrait: '判定依据：来源指向 face / portrait / cutin 等立绘资源',
  bullet: '判定依据：来源指向 etama / bullet / laser 等弹幕贴图',
  effect: '判定依据：来源指向 effect 等特效贴图',
  background: '判定依据：来源指向 stgNbg / stage / tile 等场景资源',
  item: '判定依据：来源指向 item / power / point 等道具资源',
  ui: '判定依据：来源指向 ascii / title / menu / staff 等界面资源',
  audio: '判定依据：来源为音频文件（wav / ogg / mid）',
  data: 'ECL / STD 脚本、MSG 文本与二进制数据 —— 本身没有美术用途',
  unknown: '未能从文件名判定用途，可在详情面板手动指派',
};
