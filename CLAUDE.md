# 项目工作约定（每个会话开始前必读）

## 铁律：导入解包数据 ≠ 入库就完事

每次向素材库导入新游戏 / 新版本的解包数据（无论走 `services/extractor.ts` 主管线，
还是独立的 import 脚本如 `scripts/import-th06nc.ts`），**必须同步检查并更新所有下游
视图与管线**。只把资源行写进数据库不算完成——所有展示层都要能正确消费这批数据。

### 导入完成清单（缺一项都不算完）

1. **动画查看器**（`web/src/views/AnimationView.vue`）
   - server 侧：`formats/anm.ts` 能解析新格式 ANM（thtk 64 字节头 / ZUN 旧格式 / 变体）；
     `services/anmPreview.ts` 能关联外置贴图（PNG / DDS / THTX 内嵌，按 basename 匹配，
     注意库内缓存文件可能被重命名成 code，索引需同时覆盖 filename 与路径 basename）
   - ANM 资源的 `/api/assets/:id/preview` 必须返回精灵图集 PNG（或布局图兜底），不能 415

2. **素材预览**（`services/preview.ts` + `scripts/dds-preview.py`）
   - 浏览器渲染不了的图片格式（BC7 DDS、TGA 等）必须接入 Pillow 转码管线
   - 新格式先实测解码（速度、色彩），再决定接入方式；转码依赖 python3 + Pillow，
     启动日志应显示「预览转码 就绪」

3. **研究内容的所有页面**——新游戏的资源要能进入并正确显示：
   - 角色库 `CharactersView.vue`
   - 符卡库 `SpellView.vue`
   - 敌人 / Boss `EnemiesView.vue`
   - 弹幕 `DanmakuView.vue`
   - 文本分析 `TextView.vue`——按**关卡**（dialogue.stage 列，插入关卡分隔线）+ **自机路线**
     （dialogue.route 列，路线分隔线 + 筛选下拉）分组展示；构建脚本负责写入两列
   - 音乐 `BgmView.vue`——曲目标题/场景/Boss 标注 + **道中曲标识**（见下）
   - 不能出现「资源在库里，但研究页面空白 / 查不到」

4. **预览缓存预热**：`npm --prefix server run warm-previews`（新增格式或新增资源后跑）

### 验收标准

打开工作台逐页点检：素材库缩略图有预览、动画查看器能解析新 ANM 并出精灵图、
研究各页面无空白。**导入完成 = 以上全部通过，而不是 DB 里有行。**

### 历史教训（为什么有这条约定）

- TH06NC（红魔乡 New Classic）导入时只入了库：1225 张 BC7 DDS 浏览器渲染不了
  （素材预览全空白）、ANM 没做贴图关联（动画查看器一片空白），都是事后补课才发现。
- 本约定由用户明确要求固化，防止同类问题在后续游戏导入（TH06C、其他作品）时复发。

### 已沉淀的通用机制（新作品导入直接复用，不要重写）

| 机制 | 位置 | 适用条件 |
|---|---|---|
| 素材预览转码（DDS/TGA→PNG） | `services/preview.ts` + `scripts/dds-preview.py` | 任何浏览器渲染不了的图片格式 |
| ANM 精灵图集预览 | `services/anmPreview.ts` | thtk 64 字节头 ANM（贴图外置） |
| ANM 元数据回填 + 精灵裁片提取 | `scripts/build-research-th06nc.ts` 第 5 步 | 同上 |
| msg 指令式解析（含说话方 side） | `formats/msg.ts` `parseMsgInstructions` | TH06 系 msg（原版与重制版同构）；side 0=自机侧、1=Boss 侧 |
| 本地化文本表（ID→多语言正文） | `formats/msgpack.ts` + `localization.msgpack` | TH06NC 的「ID 引用」架构（1152 条 × 12 语言） |
| 立绘编号对照（face00=灵梦…） | `services/identify.ts` `TH06_FACE_MAP_FALLBACK` | 与原版同构的重制版；AI 打标（`meta.aiTags`，WD14）优先，兜底仅无 AI 数据时生效 |
| Boss 名 ← 游戏自带文本 | `EXE_BOSS_NAME_*`（localization） | 按关卡顺序 RUMIA…FLANDRE |
| 预览缓存预热 | `npm --prefix server run warm-previews` | 新增格式或资源后 |
| 音乐元数据标注（标题/场景/Boss） | `scripts/build-research-th06nc.ts` 第 7.6 步；数据源 = 音乐室文本 `MD_NN_TITLE`/`MD_NN_DESC`（**只解析 DESC 第二行归属行**，评注行含其他关卡名会误标） | **每个版本必做**；Boss 曲场景沿用前一「面」 |

### 已知限制

- **TH06NC BGM 在线播放未解决**（曾误判已解决，用户实测为电流声后回退——
  **教训：音频解码成败必须以听感/波形统计验证，不能只看「解码无错误」**，
  错误解读也能无错误地产出垃圾音频）。容器 = 40 字节头（0x0c=48000Hz、
  0x24=数据总长、0x0a=帧大小 488、byte@9=声道）+ 6539 个 488B 定长帧，
  每帧 = 4 字节明文头 `00 00 01 e0` + 484 字节**私有编码包体**（三种切包方式
  libopus 全部报错、熵 7.99、跨包无常量特征 → 不是裸 opus，是私有加密/压缩）。
  引擎解码链已定位：加载器 0x14007ea60 → 校验 0x14007eb08/29 → 填充
  0x14007ec80 → 解码包装 0x1402a13b0 → opus_decode 0x1402a2280。`.pos`
  （循环点，字节单位）交叉验证每帧约 20ms。下一步：反汇编 0x1402a2280 内部
  找解密例程与密钥（归档例程模式见 tools/th06nc-unpack/src/pkg.ts）。
  `opus-decoder`（WASM）已安装；`formats/ncOpus.ts`（容器解析）与
  `services/bgmAudio.ts`（转码骨架）已就位。
- **TH06 的 BGM 是标准 WAV**（不是 MIDI）：已复制到 `Data/Game/TH06/BGM`，
  `/api/bgm/:id/audio` 直接播放 ✓。
- **发言轮次说话人模型**（v4，经 Stage1-7 抽样核对，自机残留 = 0）：
  msg 的 `side` 字段 = **对话框内的行槽位**（m0 开启新箱、m1 归入同箱）——
  **对话箱 = 一个发言轮次**，用槽位配对（解析器 `box` 字段）比控制记录可靠：
  多余控制记录会造成箱边界错位（曾把「ふざけやがって」和「あんたなんて、あたいが…」错配一箱）。
  **必须逐段处理**（box 编号段内重置）。
  段性质：Boss 语汇 / 自机名字 / 男女语气跨箱混合 / **长段兜底（≥6 箱）** → 对话；否则整段独白。
  对话模型：Boss 开场定位 = **窄标记**（あたい/お食/強敵/なさいよ/雇われ/メイド長/名字呼叫）优先，
  但要过**占比合理性检查**（开场独白不超过全段 60%——美铃段中段的「食べ」会误拉长独白）；
  不过检退回宽标记（人物名字限开头 4 箱内）再退回 0；此后逐箱交替；
  箱含 Boss 自称/挑衅（BOSS_SELF）→ 强制 Boss 箱并重置交替（琪露诺「あたい」句）。
  Boss 名取 `EXE_BOSS_NAME_*` 简中（露米娅/琪露诺/红美铃/帕秋莉/十六夜咲夜/蕾米莉亚/芙兰朵露）。
- **自机路线区分**（权威 = 场景槽位分区）：msg 场景表中**槽位 <10 = 灵梦的场次、
  ≥10 = 魔理沙的场次**（反证：槽 10 段含「出来ないぜ」「おおよそ夏だぜ」等魔理沙台词）。
  每段必得路线、无「自机」占位；无槽位信息的版本退回名字称呼/语气特征。
  两代作品路线分布均衡（TH06NC 306/299，TH06 260/237）。
- **对话中文翻译**（`dialogue.text_zh`，TextView 双语并排）：
  ① TH06NC 用官方简中（localization 的 zh-CN）；② TH06 与 TH06NC 是同一部作品
  （对话文本 100% 一致）→ **借译**（归一化精确匹配 + 前缀模糊匹配）；
  ③ 官方缺口（含 TH06NC 自身的空条目、借译未命中）→ **机器翻译兜底**
  （MyMemory 免费端点，`Data/Game/TH06NC/Analysis/translation-cache.json` 缓存，
  无网络时静默跳过）。当前覆盖：TH06NC 605/605、TH06 497/497。
