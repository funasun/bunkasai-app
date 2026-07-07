import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getConfig, saveConfig, reloadConfig,
  getSettings, saveSettings, setAdminPassword,
  listVotes, putVote, deleteVotesForItem, clearVotes,
  listVoteBackups, restoreVoteBackup,
  issueToken, isValidToken, verifyPassword, isLegacyHash, newId,
} from './lib/store.js';
import { METHODS, ranking, voteTotal } from './lib/aggregate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// asyncハンドラのエラーを500 JSONで返す
const ah = (fn) => (req, res) => {
  fn(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'サーバーエラーが発生しました' });
  });
};

// --- 認証（結果・管理はパスワード必須） -------------------------------

function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  isValidToken(token)
    .then((ok) => {
      if (!ok) return res.status(401).json({ error: '認証が必要です' });
      next();
    })
    .catch((e) => {
      console.error(e);
      res.status(500).json({ error: 'サーバーエラーが発生しました' });
    });
}

app.post('/api/login', ah(async (req, res) => {
  const settings = await getSettings();
  const { password } = req.body || {};
  if (!password || !verifyPassword(password, settings.adminPassword)) {
    return res.status(401).json({ error: 'パスワードが違います' });
  }
  // 旧ハッシュ保存からの移行: 正しいパスワードが分かるこの時点で平文に置き換える
  if (isLegacyHash(settings.adminPassword)) {
    settings.adminPassword = String(password);
    await saveSettings(settings);
  }
  res.json({ token: await issueToken() });
}));

// --- 投票端末向け（結果は一切返さない） ------------------------------

app.get('/api/config', ah(async (req, res) => {
  const [cfg, settings] = await Promise.all([getConfig(), getSettings()]);
  res.json({
    title: cfg.title,
    scale: cfg.scale,
    criteria: cfg.criteria,
    items: cfg.items.map((i) => ({ id: i.id, name: i.name, description: i.description || '' })),
    votingOpen: settings.votingOpen !== false,
  });
}));

// 全角数字・空白の揺れを吸収してコードを比較する
const normCode = (s) => String(s || '')
  .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  .replace(/\s/g, '');

// 審査員コードの事前確認（採点開始時のチェック用）
app.post('/api/judge-verify', ah(async (req, res) => {
  const settings = await getSettings();
  if (settings.votingOpen === false) {
    return res.status(403).json({ error: '現在は投票を受け付けていません' });
  }
  const { code, name } = req.body || {};
  if (!String(name || '').trim()) {
    return res.status(400).json({ error: 'お名前を入力してください' });
  }
  if (!normCode(code) || normCode(code) !== normCode(settings.judgeCode)) {
    return res.status(401).json({ error: '採点委員コードが違います' });
  }
  res.json({ ok: true });
}));

app.post('/api/vote', ah(async (req, res) => {
  const [settings, cfg] = await Promise.all([getSettings(), getConfig()]);
  if (settings.votingOpen === false) {
    return res.status(403).json({ error: '現在は投票を受け付けていません' });
  }
  const { voterType, voterId, itemId, scores, judgeCode } = req.body || {};
  if (!['judge', 'visitor'].includes(voterType)) {
    return res.status(400).json({ error: 'voterType が不正です' });
  }
  if (!voterId || typeof voterId !== 'string') {
    return res.status(400).json({ error: 'voterId が必要です' });
  }
  // 審査員票は「正しい審査員コード」を伴うものだけ受け付ける（なりすまし防止）
  if (voterType === 'judge') {
    const name = voterId.replace(/^judge:/, '').trim();
    if (!name) return res.status(400).json({ error: 'お名前が必要です' });
    if (normCode(judgeCode) !== normCode(settings.judgeCode)) {
      return res.status(403).json({ error: '採点委員コードが違います' });
    }
  }
  const item = cfg.items.find((i) => i.id === itemId);
  if (!item) return res.status(400).json({ error: '出し物が見つかりません' });

  const { min, max } = cfg.scale;
  const cleanScores = {};
  for (const c of cfg.criteria) {
    const v = scores?.[c.id];
    if (v === undefined || v === null || v === '') continue; // 未採点の項目は許容
    const num = Number(v);
    if (Number.isNaN(num) || num < min || num > max) {
      return res.status(400).json({ error: `点数は${min}〜${max}の範囲で入力してください` });
    }
    cleanScores[c.id] = num;
  }
  if (Object.keys(cleanScores).length === 0) {
    return res.status(400).json({ error: '少なくとも1項目は採点してください' });
  }

  await putVote({ voterType, voterId, itemId, scores: cleanScores });
  res.json({ ok: true });
}));

// --- 管理・結果（要認証） -------------------------------------------

async function adminSettingsPayload() {
  const [settings, cfg] = await Promise.all([getSettings(), getConfig()]);
  const { adminPassword, ...runtime } = settings;
  return {
    settings: {
      ...runtime,
      title: cfg.title,
      scale: cfg.scale,
      adminPassword: isLegacyHash(adminPassword) ? '' : adminPassword,
    },
    criteria: cfg.criteria,
    items: cfg.items,
    methods: METHODS,
  };
}

app.get('/api/admin/settings', requireAuth, ah(async (req, res) => {
  res.json(await adminSettingsPayload());
}));

app.put('/api/admin/settings', requireAuth, ah(async (req, res) => {
  const [settings, cfg] = await Promise.all([getSettings(), getConfig()]);
  const { title, scale, method, bayesianPrior, trimRatio, judgeCode, votingOpen } = req.body || {};
  if (typeof title === 'string') cfg.title = title;
  if (typeof votingOpen === 'boolean') settings.votingOpen = votingOpen;
  if (typeof judgeCode === 'string' && normCode(judgeCode)) settings.judgeCode = normCode(judgeCode);
  if (scale && typeof scale === 'object') {
    const min = Number(scale.min), max = Number(scale.max), step = Number(scale.step);
    if ([min, max, step].some(Number.isNaN) || min >= max || step <= 0) {
      return res.status(400).json({ error: '点数段階の値が不正です（min<max, step>0）' });
    }
    cfg.scale = { min, max, step };
  }
  if (method && METHODS.some((m) => m.id === method)) settings.method = method;
  if (bayesianPrior !== undefined) settings.bayesianPrior = Math.max(0, Number(bayesianPrior) || 0);
  if (trimRatio !== undefined) settings.trimRatio = Math.max(0, Math.min(0.45, Number(trimRatio) || 0));
  await Promise.all([saveSettings(settings), saveConfig(cfg)]);
  res.json({ settings: (await adminSettingsPayload()).settings });
}));

app.post('/api/admin/password', requireAuth, ah(async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 4) {
    return res.status(400).json({ error: 'パスワードは4文字以上にしてください' });
  }
  await setAdminPassword(password);
  res.json({ ok: true });
}));

// config.json を編集したときの再読み込み（ローカル: 手編集 / Vercel: push後）
app.post('/api/admin/reload-config', requireAuth, ah(async (req, res) => {
  try {
    await reloadConfig();
    res.json(await adminSettingsPayload());
  } catch (e) {
    res.status(400).json({ error: `config.json の読み込みに失敗しました: ${e.message}` });
  }
}));

// 出し物 CRUD
app.post('/api/admin/items', requireAuth, ah(async (req, res) => {
  const cfg = await getConfig();
  const { name, description } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '名前が必要です' });
  const item = { id: newId('i'), name: name.trim(), description: (description || '').trim() };
  cfg.items.push(item);
  await saveConfig(cfg);
  res.json(item);
}));

app.put('/api/admin/items/:id', requireAuth, ah(async (req, res) => {
  const cfg = await getConfig();
  const item = cfg.items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: '見つかりません' });
  const { name, description } = req.body || {};
  if (typeof name === 'string' && name.trim()) item.name = name.trim();
  if (typeof description === 'string') item.description = description.trim();
  await saveConfig(cfg);
  res.json(item);
}));

app.delete('/api/admin/items/:id', requireAuth, ah(async (req, res) => {
  const cfg = await getConfig();
  const idx = cfg.items.findIndex((i) => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '見つかりません' });
  cfg.items.splice(idx, 1);
  await saveConfig(cfg);
  await deleteVotesForItem(req.params.id);
  res.json({ ok: true });
}));

// 採点項目 CRUD
app.post('/api/admin/criteria', requireAuth, ah(async (req, res) => {
  const cfg = await getConfig();
  const { name, weight } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '名前が必要です' });
  const c = { id: newId('c'), name: name.trim(), weight: Number(weight) > 0 ? Number(weight) : 1 };
  cfg.criteria.push(c);
  await saveConfig(cfg);
  res.json(c);
}));

app.put('/api/admin/criteria/:id', requireAuth, ah(async (req, res) => {
  const cfg = await getConfig();
  const c = cfg.criteria.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '見つかりません' });
  const { name, weight } = req.body || {};
  if (typeof name === 'string' && name.trim()) c.name = name.trim();
  if (weight !== undefined && Number(weight) > 0) c.weight = Number(weight);
  await saveConfig(cfg);
  res.json(c);
}));

app.delete('/api/admin/criteria/:id', requireAuth, ah(async (req, res) => {
  const cfg = await getConfig();
  if (cfg.criteria.length <= 1) return res.status(400).json({ error: '採点項目は最低1つ必要です' });
  const idx = cfg.criteria.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '見つかりません' });
  cfg.criteria.splice(idx, 1);
  await saveConfig(cfg);
  res.json({ ok: true });
}));

// 結果（順位）。全集計方法での順位も返し、比較できるようにする。
app.get('/api/admin/results', requireAuth, ah(async (req, res) => {
  const [settings, cfg, votes] = await Promise.all([getSettings(), getConfig(), listVotes()]);
  const buildFor = (voterType) => {
    const current = ranking(votes, cfg.items, cfg.criteria, settings, voterType);
    const byMethod = {};
    for (const m of METHODS) {
      byMethod[m.id] = ranking(votes, cfg.items, cfg.criteria, { ...settings, method: m.id }, voterType);
    }
    return { current, byMethod };
  };
  // 審査員×出し物の採点表（総合点と項目別の生点）
  const judgeVotes = votes.filter((v) => v.voterType === 'judge');
  const judgeNames = [...new Set(judgeVotes.map((v) => v.voterId.replace(/^judge:/, '')))]
    .sort((a, b) => a.localeCompare(b, 'ja'));
  const judgeTable = {};
  for (const v of judgeVotes) {
    const name = v.voterId.replace(/^judge:/, '');
    if (!judgeTable[name]) judgeTable[name] = {};
    judgeTable[name][v.itemId] = {
      total: Math.round(voteTotal(v, cfg.criteria) * 100) / 100,
      scores: v.scores,
    };
  }

  res.json({
    method: settings.method,
    methods: METHODS,
    judge: buildFor('judge'),
    visitor: buildFor('visitor'),
    all: buildFor(null),
    judgeNames,
    judgeTable,
    counts: {
      judgeVotes: votes.filter((v) => v.voterType === 'judge').length,
      visitorVotes: votes.filter((v) => v.voterType === 'visitor').length,
    },
  });
}));

// 生データのエクスポート（CSV）
app.get('/api/admin/export.csv', requireAuth, ah(async (req, res) => {
  const [cfg, votes] = await Promise.all([getConfig(), listVotes()]);
  const header = ['voterType', 'voterId', 'itemId', 'itemName', ...cfg.criteria.map((c) => c.name), 'createdAt'];
  const rows = votes.map((v) => {
    const item = cfg.items.find((i) => i.id === v.itemId);
    return [
      v.voterType, v.voterId, v.itemId, item ? item.name : '',
      ...cfg.criteria.map((c) => (v.scores?.[c.id] ?? '')),
      v.createdAt || '',
    ];
  });
  const csv = [header, ...rows]
    .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="votes.csv"');
  res.send('﻿' + csv); // BOM付きでExcel対応
}));

// 投票データのリセット（直近2世代までバックアップから復元できる）
app.delete('/api/admin/votes', requireAuth, ah(async (req, res) => {
  await clearVotes();
  res.json({ ok: true, backups: await listVoteBackups() });
}));

app.get('/api/admin/vote-backups', requireAuth, ah(async (req, res) => {
  res.json({ backups: await listVoteBackups() });
}));

app.post('/api/admin/vote-backups/:slot/restore', requireAuth, ah(async (req, res) => {
  const slot = Number(req.params.slot);
  if (![1, 2].includes(slot)) return res.status(400).json({ error: 'slot が不正です' });
  const count = await restoreVoteBackup(slot);
  if (count === null) return res.status(404).json({ error: 'バックアップが見つかりません' });
  res.json({ ok: true, count });
}));

export default app;

// Vercel上ではサーバーレス関数として動くため、ローカル実行時のみlistenする
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n文化祭 採点アプリ 起動`);
    console.log(`  投票画面 : http://localhost:${PORT}/`);
    console.log(`  管理/結果: http://localhost:${PORT}/admin.html （初期パスワード: admin）`);
    console.log(`  他端末から: http://<このPCのIPアドレス>:${PORT}/\n`);
  });
}
