import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  listCharacters,
  listEnemies,
  listEnemyIntel,
  getCharacterAssets,
  listPatterns,
  getPattern,
  savePattern,
  savePatternActions,
  deletePattern,
  listSpells,
  saveSpell,
  deleteSpell,
  listBgm,
  updateBgm,
  searchMsg,
  listMsg,
} from '../services/query.ts';
import { harvestSpellCandidates, importSpellCandidates, seedKnownSpells } from '../services/spellcards.ts';
import { collectSequences, buildStageFields } from '../services/danmakuSequences.ts';
import { buildSpellIntel } from '../services/spellIntel.ts';
import { actionsToBir, inferBirPattern, validateBir, birToSimParams, birToGodot, birToUnity } from '../core/bir.ts';
import { ensureNcOpusWav } from '../services/bgmAudio.ts';

export const analysisRouter = Router();

// ---------------------------------------------------------------- 角色

analysisRouter.get('/characters', (req, res) => {
  res.json({ items: listCharacters((req.query as any).gameId) });
});

analysisRouter.get('/characters/:id', (req, res) => {
  res.json(getCharacterAssets(req.params.id));
});

// ---------------------------------------------------------------- 怪物

analysisRouter.get('/enemies', (req, res) => {
  res.json({ items: listEnemies((req.query as any).gameId) });
});

/**
 * 怪物库增强数据：敌机记录 + 精灵预览 + 该关的 ECL 行为属性。
 * 放在 /enemies/:id 之前注册，避免 'intel' 被当成 id 匹配。
 */
analysisRouter.get('/enemies/intel', (req, res) => {
  const gameId = (req.query as any).gameId as string | undefined;
  if (!gameId) {
    res.status(400).json({ error: '缺少 gameId 参数' });
    return;
  }
  res.json({ items: listEnemyIntel(gameId) });
});

// ---------------------------------------------------------------- 弹幕模式

analysisRouter.get('/patterns', (req, res) => {
  const q = req.query as Record<string, string>;
  res.json({ items: listPatterns(q.gameId, q.type) });
});

/** 弹幕模式详情，含 Bullet_Action 动作时间轴 */
analysisRouter.get('/patterns/:code', (req, res) => {
  const p = getPattern(req.params.code);
  if (!p) {
    res.status(404).json({ error: '弹幕模式不存在' });
    return;
  }
  res.json(p);
});

/** 覆盖写入动作时间轴（弹幕编辑器的保存入口） */
analysisRouter.put('/patterns/:code/actions', (req, res) => {
  const actions = (req.body ?? {}).actions;
  if (!Array.isArray(actions)) {
    res.status(400).json({ error: '缺少 actions 数组' });
    return;
  }
  const result = savePatternActions(req.params.code, actions);
  if (!result) {
    res.status(404).json({ error: '弹幕模式不存在' });
    return;
  }
  res.json(result);
});

analysisRouter.post('/patterns', (req, res) => {
  const body = req.body ?? {};
  if (!body.name || !body.type) {
    res.status(400).json({ error: '缺少 name 或 type' });
    return;
  }
  res.json(savePattern(body));
});

analysisRouter.delete('/patterns/:id', (req, res) => {
  deletePattern(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- BIR 弹幕中间语言

/** 取得弹幕模式的 BIR（引擎无关的中间表示） */
analysisRouter.get('/patterns/:code/bir', (req, res) => {
  const p = getPattern(req.params.code);
  if (!p) {
    res.status(404).json({ error: '弹幕模式不存在' });
    return;
  }
  const actions = (p.actions ?? []).map((a: any) => ({ time: a.time, action_type: a.action_type, parameter: a.parameter }));
  const bir = actionsToBir(p.name, p.type, actions, { game: p.game_id, origin: p.origin, note: p.note });
  res.json({ ...bir, inferredPattern: inferBirPattern(bir.events) });
});

/** 校验并转换外部 BIR */
analysisRouter.post('/bir/validate', (req, res) => {
  const result = validateBir(req.body);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  const bir = result.bir!;
  res.json({ ok: true, inferredPattern: inferBirPattern(bir.events), simParams: birToSimParams(bir) });
});

/**
 * ECL 弹幕序列：从行为脚本还原的发射事件，供前端回放「弹幕实际是怎么跑的」。
 * 与 /danmaku/simulate 的区别：后者是参数化模拟，前者是作品里的真实数据。
 */
analysisRouter.get('/danmaku/sequences', (req, res) => {
  const gameId = (req.query as any).gameId as string | undefined;
  if (!gameId) {
    res.status(400).json({ error: '缺少 gameId 参数' });
    return;
  }
  res.json({ stages: collectSequences(gameId) });
});

/**
 * 关卡弹幕场：该关全部子程序的发射事件合并后的完整弹幕形态，
 * 每次发射挂到从主时间线提取的真实敌机坐标上。
 */
analysisRouter.get('/danmaku/fields', (req, res) => {
  const gameId = (req.query as any).gameId as string | undefined;
  if (!gameId) {
    res.status(400).json({ error: '缺少 gameId 参数' });
    return;
  }
  res.json({ stages: buildStageFields(gameId) });
});

/**
 * 符卡情报：从 ECL 定位 Boss 战，给出每场符卡的难度覆盖、持续时间与弹幕特征。
 * 顺序与游戏内符卡出现顺序一致，供与 MSG 挖掘的符卡名并排核对。
 */
analysisRouter.get('/spells/intel', (req, res) => {
  const gameId = (req.query as any).gameId as string | undefined;
  if (!gameId) {
    res.status(400).json({ error: '缺少 gameId 参数' });
    return;
  }
  res.json(buildSpellIntel(gameId));
});

/** BIR → 引擎格式 */
analysisRouter.post('/bir/export', (req, res) => {
  const validate = validateBir(req.body?.bir ?? req.body);
  if (!validate.ok) {
    res.status(400).json(validate);
    return;
  }
  const bir = validate.bir!;
  const target = String(req.body?.target ?? 'json');
  if (target === 'godot') {
    res.type('text/plain').send(birToGodot(bir));
    return;
  }
  if (target === 'unity') {
    res.json(birToUnity(bir));
    return;
  }
  res.json({
    ...bir,
    inferredPattern: inferBirPattern(bir.events),
    simParams: birToSimParams(bir),
  });
});

// ---------------------------------------------------------------- 符卡

analysisRouter.get('/spells', (req, res) => {
  res.json({ items: listSpells((req.query as any).gameId) });
});

analysisRouter.post('/spells', (req, res) => {
  const body = req.body ?? {};
  if (!body.name) {
    res.status(400).json({ error: '缺少 name' });
    return;
  }
  res.json(saveSpell(body));
});

analysisRouter.delete('/spells/:id', (req, res) => {
  deleteSpell(req.params.id);
  res.json({ ok: true });
});

/** 从剧情文本中自动挖掘符卡名 */
analysisRouter.post('/spells/harvest/preview', (req, res) => {
  const gameId = (req.body ?? {}).gameId as string | undefined;
  res.json({ items: harvestSpellCandidates(gameId) });
});

analysisRouter.post('/spells/harvest', (req, res) => {
  const body = req.body ?? {};
  const gameId = body.gameId as string | undefined;
  const candidates = body.candidates ?? harvestSpellCandidates(gameId);
  res.json(importSpellCandidates(candidates));
});

analysisRouter.post('/spells/seed', (req, res) => {
  const gameId = (req.body ?? {}).gameId ?? 'TH06';
  res.json({ imported: seedKnownSpells(gameId) });
});

// ---------------------------------------------------------------- BGM

analysisRouter.get('/bgm', (req, res) => {
    res.json({ items: listBgm((req.query as any).gameId) });
  });

  /** 曲目音频流：WAV 直接播放；TH06NC 的自定义 opus 容器即时转码（缓存后秒开） */
  analysisRouter.get('/bgm/:id/audio', async (req, res) => {
    const row = listBgm().find((t) => String(t.id) === req.params.id);
    if (!row?.cache_path || !fs.existsSync(row.cache_path)) {
      res.status(404).json({ error: '曲目音频文件不存在' });
      return;
    }
    if (row.codec === 'opus') {
      const wav = await ensureNcOpusWav(row.cache_path);
      if (!wav) {
        res.status(415).json({ error: 'BGM 转码失败，详见服务端日志' });
        return;
      }
      res.type('audio/wav').sendFile(path.resolve(wav));
      return;
    }
    res.sendFile(path.resolve(row.cache_path));
  });

analysisRouter.patch('/bgm/:id', (req, res) => {
  const updated = updateBgm(req.params.id, req.body ?? {});
  if (!updated) {
    res.status(404).json({ error: '曲目不存在' });
    return;
  }
  res.json(updated);
});

// ---------------------------------------------------------------- 文本

analysisRouter.get('/msg', (req, res) => {
  const q = req.query as Record<string, string>;
  if (q.q) {
    res.json({ items: searchMsg(q.q, q.gameId, q.limit ? parseInt(q.limit, 10) : 200) });
    return;
  }
  if (!q.gameId) {
    res.status(400).json({ error: '需要提供 gameId 或 q 参数' });
    return;
  }
  res.json({ items: listMsg(q.gameId, q.assetId, q.limit ? parseInt(q.limit, 10) : 500) });
});
