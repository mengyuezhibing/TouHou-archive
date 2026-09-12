/**
 * 东方 Project 作品元数据表（Windows 平台整数作 + 主要小数点作）。
 * 用于游戏扫描阶段的作品识别：通过 exe / dat 文件名匹配。
 */

export interface TitleMeta {
  id: string;
  name: string;
  nameJp: string;
  year: number;
  engine: string;
  /** 主归档文件名 */
  mainDat: string;
  exe: string;
  /** 素材规模预期（用于界面展示画像） */
  kind: 'stg' | 'fighting' | 'photo' | 'other';
  note?: string;
}

export const TITLES: TitleMeta[] = [
  { id: 'TH01', name: '东方灵异传', nameJp: '東方靈異伝', year: 1996, engine: 'PC-98', mainDat: '', exe: 'th01.exe', kind: 'other', note: 'PC-98 平台，文件结构与本工作台主力解析器不同' },
  { id: 'TH02', name: '东方封魔录', nameJp: '東方封魔録', year: 1997, engine: 'PC-98', mainDat: '', exe: 'th02.exe', kind: 'other' },
  { id: 'TH03', name: '东方梦时空', nameJp: '東方夢時空', year: 1997, engine: 'PC-98', mainDat: '', exe: 'th03.exe', kind: 'other' },
  { id: 'TH04', name: '东方幻想乡', nameJp: '東方幻想郷', year: 1998, engine: 'PC-98', mainDat: '', exe: 'th04.exe', kind: 'other' },
  { id: 'TH05', name: '东方怪绮谈', nameJp: '東方怪綺談', year: 1998, engine: 'PC-98', mainDat: '', exe: 'th05.exe', kind: 'other' },

  { id: 'TH06', name: '东方红魔乡', nameJp: '東方紅魔郷', year: 2002, engine: 'ZUN_STG', mainDat: 'th06.dat', exe: 'th06.exe', kind: 'stg', note: 'ANM 贴图为 JPEG 内嵌，DAT 使用变长文件名表' },
  { id: 'TH07', name: '东方妖妖梦', nameJp: '東方妖々夢', year: 2003, engine: 'ZUN_STG', mainDat: 'th07.dat', exe: 'th07.exe', kind: 'stg', note: '引入 64 位色深与更丰富的 ANM 脚本' },
  { id: 'TH08', name: '东方永夜抄', nameJp: '東方永夜抄', year: 2004, engine: 'ZUN_STG', mainDat: 'th08.dat', exe: 'th08.exe', kind: 'stg', note: 'ANM 贴图转为 PNG，DAT 使用 16 字节定长文件名表' },
  { id: 'TH09', name: '东方花映塚', nameJp: '東方花映塚', year: 2005, engine: 'ZUN_STG', mainDat: 'th09.dat', exe: 'th09.exe', kind: 'stg' },
  { id: 'TH09.5', name: '东方文花帖', nameJp: '東方文花帖', year: 2005, engine: 'ZUN_STG', mainDat: 'th095.dat', exe: 'th095.exe', kind: 'photo' },
  { id: 'TH10', name: '东方风神录', nameJp: '東方風神録', year: 2007, engine: 'ZUN_STG', mainDat: 'th10.dat', exe: 'th10.exe', kind: 'stg', note: 'DAT 表新增每项 size 字段' },
  { id: 'TH11', name: '东方地灵殿', nameJp: '東方地霊殿', year: 2008, engine: 'ZUN_STG', mainDat: 'th11.dat', exe: 'th11.exe', kind: 'stg' },
  { id: 'TH12', name: '东方星莲船', nameJp: '東方星蓮船', year: 2009, engine: 'ZUN_STG', mainDat: 'th12.dat', exe: 'th12.exe', kind: 'stg' },
  { id: 'TH12.5', name: '东方文花帖DS', nameJp: 'ダブルスポイラー', year: 2010, engine: 'ZUN_STG', mainDat: 'th125.dat', exe: 'th125.exe', kind: 'photo' },
  { id: 'TH12.8', name: '妖精大战争', nameJp: '妖精大戦争', year: 2010, engine: 'ZUN_STG', mainDat: 'th128.dat', exe: 'th128.exe', kind: 'stg' },
  { id: 'TH13', name: '东方神灵庙', nameJp: '東方神霊廟', year: 2011, engine: 'ZUN_STG', mainDat: 'th13.dat', exe: 'th13.exe', kind: 'stg' },
  { id: 'TH14', name: '东方辉针城', nameJp: '東方輝針城', year: 2013, engine: 'ZUN_STG', mainDat: 'th14.dat', exe: 'th14.exe', kind: 'stg' },
  { id: 'TH15', name: '东方绀珠传', nameJp: '東方紺珠伝', year: 2015, engine: 'ZUN_STG', mainDat: 'th15.dat', exe: 'th15.exe', kind: 'stg' },
  { id: 'TH16', name: '东方天空璋', nameJp: '東方天空璋', year: 2017, engine: 'ZUN_STG', mainDat: 'th16.dat', exe: 'th16.exe', kind: 'stg' },
  { id: 'TH17', name: '东方鬼形兽', nameJp: '東方鬼形獣', year: 2019, engine: 'ZUN_STG', mainDat: 'th17.dat', exe: 'th17.exe', kind: 'stg' },
  { id: 'TH18', name: '东方虹龙洞', nameJp: '東方虹龍洞', year: 2021, engine: 'ZUN_STG', mainDat: 'th18.dat', exe: 'th18.exe', kind: 'stg' },
  { id: 'TH19', name: '东方兽王园', nameJp: '東方獣王園', year: 2023, engine: 'ZUN_STG', mainDat: 'th19.dat', exe: 'th19.exe', kind: 'stg' },
];

export function findTitleByFileName(fileName: string): TitleMeta | null {
  const lower = fileName.toLowerCase();
  // 精确匹配 exe / dat
  const byExact = TITLES.find((t) => t.exe === lower || (t.mainDat && t.mainDat === lower));
  if (byExact) return byExact;

  // 形如 th06.dat / th06_01.dat / th6.dat
  const m = lower.match(/^(th\d{2}(?:\.\d)?)(?:[_\-.]|$)/);
  if (m) {
    const code = m[1];
    const found = TITLES.find((t) => t.id.toLowerCase() === code || t.id.toLowerCase().replace('.', '') === code);
    if (found) return found;
    // 形如 th095 -> TH09.5
    const alt = code.replace(/^th(\d{2})(\d)$/, 'th$1.$2');
    const foundAlt = TITLES.find((t) => t.id.toLowerCase() === alt);
    if (foundAlt) return foundAlt;
  }
  return null;
}

export function findTitleById(id: string): TitleMeta | null {
  return TITLES.find((t) => t.id.toUpperCase() === id.toUpperCase()) ?? null;
}

/** 该作品是否属于本工作台主解析器覆盖范围（Windows 版 ZUN 引擎） */
export function isSupported(title: TitleMeta | null): boolean {
  return !!title && title.engine === 'ZUN_STG';
}
