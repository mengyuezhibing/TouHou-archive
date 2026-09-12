/**
 * SQLite 表结构定义（对应《东方资源库数据库设计文档 V1.0》）。
 *
 * 命名约定：
 *  - 表名与字段名使用文档语义的 snake_case 形式（Game→game、BulletPattern→bullet_pattern）
 *  - 主键统一为 INTEGER PRIMARY KEY AUTOINCREMENT，另有业务可读编码列（game.code / resource.code）
 *    供 API 与界面使用，避免把可读 ID 直接当物理主键
 *  - 标签按文档第 16 节实现为 Tag + Resource_Tag 多对多，不再使用 JSON 数组
 */
export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ================================================================ 元信息

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ================================================================ 一、游戏表 Game

CREATE TABLE IF NOT EXISTS game (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT UNIQUE NOT NULL,      -- TH06
  name           TEXT NOT NULL,             -- 东方红魔乡
  name_jp        TEXT,
  short_name     TEXT,                      -- 红魔乡
  release_year   INTEGER,
  engine         TEXT,                      -- ZUN_STG
  version        TEXT,
  root_path      TEXT,
  exe_path       TEXT,
  kind           TEXT,                      -- stg / fighting / photo / other
  status         TEXT DEFAULT 'idle',       -- idle / scanned / extracted
  note           TEXT,
  created_time   TEXT,
  scanned_time   TEXT,
  extracted_time TEXT
);

-- ================================================================ 二、资源包表 Archive

CREATE TABLE IF NOT EXISTS archive (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id      INTEGER NOT NULL,
  filename     TEXT NOT NULL,
  file_path    TEXT NOT NULL,
  type         TEXT,                        -- dat / bgm
  size         INTEGER DEFAULT 0,
  hash         TEXT,
  entry_count  INTEGER DEFAULT 0,
  layout       TEXT,                        -- PBG3 / PBG4 / PBGZ / ...
  confidence   REAL DEFAULT 0,
  notes        TEXT,
  parsed_time  TEXT,
  UNIQUE(game_id, file_path),
  FOREIGN KEY(game_id) REFERENCES game(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_archive_game ON archive(game_id);

-- ================================================================ 三、原始资源表 Resource（核心）

CREATE TABLE IF NOT EXISTS resource (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT UNIQUE NOT NULL,       -- TH06_SPRITE_0001（对外可读编码）
  game_id       INTEGER NOT NULL,
  archive_id    INTEGER,
  filename      TEXT NOT NULL,              -- 归档内原始条目名
  display_name  TEXT,
  resource_type TEXT NOT NULL,              -- IMAGE / ANIMATION / SCRIPT / TEXT / MUSIC / AUDIO / BINARY
  kind          TEXT,                       -- 细分类型：image / anm / ecl / msg / std / bgm / binary
  category      TEXT,                       -- sprite / bullet / effect / portrait / ui / background / sheet
  role          TEXT,                       -- player / enemy / boss / effect / ui / unknown
  ext           TEXT,
  path          TEXT,                       -- 缓存文件路径
  size          INTEGER DEFAULT 0,
  hash          TEXT,
  entry_offset  INTEGER DEFAULT 0,
  meta          TEXT DEFAULT '{}',
  created_time  TEXT,
  FOREIGN KEY(game_id) REFERENCES game(id) ON DELETE CASCADE,
  FOREIGN KEY(archive_id) REFERENCES archive(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_resource_game ON resource(game_id);
CREATE INDEX IF NOT EXISTS idx_resource_type ON resource(resource_type);
CREATE INDEX IF NOT EXISTS idx_resource_kind ON resource(kind);
CREATE INDEX IF NOT EXISTS idx_resource_category ON resource(category);
CREATE INDEX IF NOT EXISTS idx_resource_role ON resource(role);
CREATE INDEX IF NOT EXISTS idx_resource_archive ON resource(archive_id);

-- ================================================================ 四、图片资源表 Asset_Image

CREATE TABLE IF NOT EXISTS asset_image (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id    INTEGER NOT NULL UNIQUE,
  width          INTEGER DEFAULT 0,
  height         INTEGER DEFAULT 0,
  format         TEXT,                      -- PNG / JPEG / BMP / DDS
  thumbnail      TEXT,
  has_alpha      INTEGER DEFAULT 0,
  dominant_color TEXT,
  color_names    TEXT DEFAULT '[]',
  FOREIGN KEY(resource_id) REFERENCES resource(id) ON DELETE CASCADE
);

-- ================================================================ 五、角色表 Character

CREATE TABLE IF NOT EXISTS character (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id         INTEGER NOT NULL,
  name            TEXT NOT NULL,
  nickname        TEXT,
  type            TEXT,                     -- PLAYER / ENEMY / BOSS / EX_BOSS / OTHER
  description     TEXT,
  sprite_count    INTEGER DEFAULT 0,
  animation_count INTEGER DEFAULT 0,
  colors          TEXT DEFAULT '[]',
  source          TEXT,
  meta            TEXT DEFAULT '{}',
  FOREIGN KEY(game_id) REFERENCES game(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_character_name ON character(name);
CREATE INDEX IF NOT EXISTS idx_character_game ON character(game_id);

-- ================================================================ 六、角色素材关联表 Character_Asset

CREATE TABLE IF NOT EXISTS character_asset (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL,
  resource_id  INTEGER NOT NULL,
  asset_type   TEXT,                        -- IDLE / SHOT / SPELL / PORTRAIT / DAMAGE / OTHER
  UNIQUE(character_id, resource_id),
  FOREIGN KEY(character_id) REFERENCES character(id) ON DELETE CASCADE,
  FOREIGN KEY(resource_id) REFERENCES resource(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_character_asset_char ON character_asset(character_id);

-- ================================================================ 七、动画系统 Animation / Animation_Frame

CREATE TABLE IF NOT EXISTS animation (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id INTEGER NOT NULL,             -- 来源 ANM
  name        TEXT NOT NULL,
  frame_count INTEGER DEFAULT 0,
  fps         INTEGER DEFAULT 12,
  loop        INTEGER DEFAULT 0,
  meta        TEXT DEFAULT '{}',
  FOREIGN KEY(resource_id) REFERENCES resource(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_animation_resource ON animation(resource_id);

CREATE TABLE IF NOT EXISTS animation_frame (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  animation_id INTEGER NOT NULL,
  image_id     INTEGER,                     -- → resource.id（该帧使用的精灵）
  frame_index  INTEGER NOT NULL,
  duration     REAL DEFAULT 1,
  x            REAL DEFAULT 0,
  y            REAL DEFAULT 0,
  w            REAL DEFAULT 0,
  h            REAL DEFAULT 0,
  rotation     REAL DEFAULT 0,
  scale        REAL DEFAULT 1,
  FOREIGN KEY(animation_id) REFERENCES animation(id) ON DELETE CASCADE,
  FOREIGN KEY(image_id) REFERENCES resource(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_animation_frame_anim ON animation_frame(animation_id);

-- ================================================================ 八、敌人表 Enemy

CREATE TABLE IF NOT EXISTS enemy (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT,                         -- FAIRY / YOUKAI / BOSS / EX_BOSS
  hp          INTEGER DEFAULT 0,
  speed       REAL DEFAULT 0,
  description TEXT,
  sprite_id   INTEGER,
  meta        TEXT DEFAULT '{}',
  FOREIGN KEY(game_id) REFERENCES game(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_enemy_game ON enemy(game_id);
CREATE INDEX IF NOT EXISTS idx_enemy_type ON enemy(type);

-- ================================================================ 九、Boss 系统

CREATE TABLE IF NOT EXISTS boss (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id      INTEGER NOT NULL,
  character_id INTEGER,
  name         TEXT NOT NULL,
  stage        INTEGER,
  rank         TEXT,                        -- BOSS / MIDBOSS / EXTRA / PHANTASM
  description  TEXT,
  meta         TEXT DEFAULT '{}',
  FOREIGN KEY(game_id) REFERENCES game(id) ON DELETE CASCADE,
  FOREIGN KEY(character_id) REFERENCES character(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_boss_game ON boss(game_id);

-- ================================================================ 十、符卡表 SpellCard

CREATE TABLE IF NOT EXISTS spell_card (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id     INTEGER,
  boss_id     INTEGER,
  boss        TEXT,                         -- 冗余名字，便于无 Boss 记录时直接标注
  name        TEXT NOT NULL,
  difficulty  TEXT,
  duration    INTEGER DEFAULT 0,
  description TEXT,
  evaluation  TEXT,
  reference   TEXT,
  source      TEXT,
  created_time TEXT,
  FOREIGN KEY(game_id) REFERENCES game(id) ON DELETE CASCADE,
  FOREIGN KEY(boss_id) REFERENCES boss(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_spell_game ON spell_card(game_id);
CREATE INDEX IF NOT EXISTS idx_spell_boss ON spell_card(boss_id);

-- ================================================================ 十一、弹幕模式 BulletPattern

CREATE TABLE IF NOT EXISTS bullet_pattern (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT UNIQUE NOT NULL,        -- TH06_SCRIPT_0001_RING（对外可读编码）
  game_id      INTEGER,
  spell_id     INTEGER,
  resource_id  INTEGER,                     -- 来源 ECL
  name         TEXT NOT NULL,
  type         TEXT,                        -- CIRCLE / SPIRAL / LASER / WAVE / RANDOM
  duration     REAL DEFAULT 0,
  difficulty   TEXT,
  params       TEXT DEFAULT '{}',
  origin       TEXT DEFAULT 'analyzed',     -- analyzed / designed
  tags         TEXT DEFAULT '[]',           -- 模式自身的检索标签（资源标签走 Resource_Tag）
  note         TEXT,
  created_time TEXT,
  updated_time TEXT,
  FOREIGN KEY(game_id) REFERENCES game(id) ON DELETE CASCADE,
  FOREIGN KEY(spell_id) REFERENCES spell_card(id) ON DELETE SET NULL,
  FOREIGN KEY(resource_id) REFERENCES resource(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_pattern_type ON bullet_pattern(type);
CREATE INDEX IF NOT EXISTS idx_pattern_game ON bullet_pattern(game_id);

-- ================================================================ 十二、弹幕动作表 Bullet_Action（时间轴）

CREATE TABLE IF NOT EXISTS bullet_action (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_id  INTEGER NOT NULL,
  time        REAL DEFAULT 0,               -- 相对时间（秒）
  action_type TEXT NOT NULL,                -- spawn / rotate / accel / wait / laser / clear
  parameter   TEXT DEFAULT '{}',
  FOREIGN KEY(pattern_id) REFERENCES bullet_pattern(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bullet_action_pattern ON bullet_action(pattern_id);

-- ================================================================ 十三、子弹表 Bullet

CREATE TABLE IF NOT EXISTS bullet (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id  INTEGER,
  image_id INTEGER,
  name     TEXT,
  type     TEXT,                            -- small / laser / star / knife / orb
  color    TEXT,
  radius   REAL DEFAULT 0,
  meta     TEXT DEFAULT '{}',
  FOREIGN KEY(game_id) REFERENCES game(id) ON DELETE CASCADE,
  FOREIGN KEY(image_id) REFERENCES resource(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_bullet_game ON bullet(game_id);

-- ================================================================ 十四、音乐表 Music

CREATE TABLE IF NOT EXISTS music (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id   INTEGER NOT NULL,
  index_num INTEGER DEFAULT 0,
  title     TEXT,
  filename  TEXT,
  codec     TEXT,
  size      INTEGER DEFAULT 0,
  path      TEXT,
  boss      TEXT,
  stage     TEXT,
  meta      TEXT DEFAULT '{}',
  FOREIGN KEY(game_id) REFERENCES game(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_music_game ON music(game_id);

-- ================================================================ 十五、文本表 Dialogue

CREATE TABLE IF NOT EXISTS dialogue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id      INTEGER NOT NULL,
  resource_id  INTEGER,
  character_id INTEGER,
  speaker      TEXT,
  text         TEXT,
  scene        TEXT,
  time         INTEGER DEFAULT 0,
  encoding     TEXT,
  FOREIGN KEY(game_id) REFERENCES game(id) ON DELETE CASCADE,
  FOREIGN KEY(resource_id) REFERENCES resource(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_dialogue_game ON dialogue(game_id);
CREATE INDEX IF NOT EXISTS idx_dialogue_char ON dialogue(character_id);

-- ================================================================ 十六、标签系统 Tag / Resource_Tag

CREATE TABLE IF NOT EXISTS tag (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT UNIQUE NOT NULL,
  category TEXT,                            -- 分组：color / role / trait / user
  color    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tag_name ON tag(name);

CREATE TABLE IF NOT EXISTS resource_tag (
  resource_id INTEGER NOT NULL,
  tag_id      INTEGER NOT NULL,
  PRIMARY KEY(resource_id, tag_id),
  FOREIGN KEY(resource_id) REFERENCES resource(id) ON DELETE CASCADE,
  FOREIGN KEY(tag_id) REFERENCES tag(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_resource_tag_tag ON resource_tag(tag_id);

CREATE TABLE IF NOT EXISTS character_tag (
  character_id INTEGER NOT NULL,
  tag_id       INTEGER NOT NULL,
  PRIMARY KEY(character_id, tag_id),
  FOREIGN KEY(character_id) REFERENCES character(id) ON DELETE CASCADE,
  FOREIGN KEY(tag_id) REFERENCES tag(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_character_tag_tag ON character_tag(tag_id);

-- ================================================================ 十七、用户笔记 Note

CREATE TABLE IF NOT EXISTS note (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type  TEXT,                        -- resource / game / spell / pattern / boss
  target_id    INTEGER,
  target_code  TEXT,                        -- 可读目标编码
  title        TEXT,
  content      TEXT,
  created_time TEXT,
  updated_time TEXT
);
CREATE INDEX IF NOT EXISTS idx_note_target ON note(target_type, target_id);

-- ================================================================ 十八、项目设计导出表 Custom_Design

CREATE TABLE IF NOT EXISTS custom_design (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT UNIQUE,
  type         TEXT NOT NULL,               -- boss / weapon / meta / project
  name         TEXT NOT NULL,
  json         TEXT DEFAULT '{}',
  created_time TEXT,
  updated_time TEXT
);
CREATE INDEX IF NOT EXISTS idx_custom_design_type ON custom_design(type);

-- ================================================================ 支撑表：解包任务

CREATE TABLE IF NOT EXISTS job (
  id           TEXT PRIMARY KEY,
  game_code    TEXT,
  kind         TEXT,
  status       TEXT,
  progress     INTEGER DEFAULT 0,
  message      TEXT,
  stats        TEXT DEFAULT '{}',
  started_time TEXT,
  finished_time TEXT
);

-- ================================================================ 扩展位（文档第 21 节）

-- 图片识别 / 弹幕分类 / 颜色分析 / 设计建议的 AI 结果
CREATE TABLE IF NOT EXISTS ai_analysis (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT,
  target_id   INTEGER,
  kind        TEXT,                         -- image / pattern / color / suggestion
  result      TEXT DEFAULT '{}',
  confidence  REAL DEFAULT 0,
  created_time TEXT
);

-- 引擎导出配置与产物
CREATE TABLE IF NOT EXISTS export_profile (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT UNIQUE,
  name        TEXT,
  target      TEXT,                         -- godot / unity / unreal
  options     TEXT DEFAULT '{}',
  created_time TEXT
);
`;
