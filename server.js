import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  getDb, getConfig, save, saveConfig, reloadConfig,
  verifyPassword, setAdminPassword, newId,
} from './lib/store.js';
import { METHODS, ranking } from './lib/aggregate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// --- 認証（結果・管理はパスワード必須） -------------------------------
const sessions = new Map(); // token -> expiry(ms)
const SESSION_TTL = 1000 * 60 * 60 * 8; // 8時間

function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  return token;
}

function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const exp = sessions.get(token);
  if (!exp || exp < Date.now()) {
    if (exp) sessions.delete(token);
    return res.status(401).json({ error: '認証が必要です' });
  }
  next();
}

app.post('/api/login', (req, res) => {
  const db = getDb();
  const { password } = req.body || {};
  if (!password || !verifyPassword(password, db.settings.adminPassword)) {
    return res.status(401).json({ error: 'パスワードが違います' });
  }
  res.json({ token: issueToken() });
});

// --- 投票端末向け（結果は一切返さない） ------------------------------
app.get('/api/config', (req, res) => {
  const cfg = getConfig();
  res.json({
    title: cfg.title,
    scale: cfg.scale,
    criteria: cfg.criteria,
    items: cfg.items.map((i) => ({ id: i.id, name: i.name, description: i.description || '' })),
    judges: cfg.judges,
  });
});

// 審査員コードの事前確認（採点開始時のチェック用）
app.post('/api/judge-verify', (req, res) => {
  const db = getDb();
  const cfg = getConfig();
  const { code, name } = req.body || {};
  if (!cfg.judges.includes(String(name || '').trim())) {
    return res.status(403).json({ error: '登録されていない審査員です' });
  }
  if (!code || String(code).trim() !== db.settings.judgeCode) {
    return res.status(401).json({ error: '審査員コードが違います' });
  }
  res.json({ ok: true });
});

app.post('/api/vote', (req, res) => {
  const db = getDb();
  const cfg = getConfig();
  const { voterType, voterId, itemId, scores, judgeCode } = req.body || {};
  if (!['judge', 'visitor'].includes(voterType)) {
    return res.status(400).json({ error: 'voterType が不正です' });
  }
  if (!voterId || typeof voterId !== 'string') {
    return res.status(400).json({ error: 'voterId が必要です' });
  }
  // 審査員票は「登録済みの審査員」かつ「正しいコード」のみ受け付ける
  if (voterType === 'judge') {
    const name = voterId.replace(/^judge:/, '').trim();
    if (!cfg.judges.includes(name)) {
      return res.status(403).json({ error: '登録されていない審査員です' });
    }
    if (String(judgeCode || '').trim() !== db.settings.judgeCode) {
      return res.status(403).json({ error: '審査員コードが違います' });
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

  // 同じ投票者が同じ出し物へ再投票した場合は上書き（二重投票防止）
  const existing = db.votes.find(
    (v) => v.voterType === voterType && v.voterId === voterId && v.itemId === itemId,
  );
  if (existing) {
    existing.scores = cleanScores;
    existing.updatedAt = new Date().toISOString();
  } else {
    db.votes.push({
      id: newId('v'),
      voterType,
      voterId,
      itemId,
      scores: cleanScores,
      createdAt: new Date().toISOString(),
    });
  }
  save();
  res.json({ ok: true });
});

// --- 管理・結果（要認証） -------------------------------------------
function adminSettingsPayload() {
  const db = getDb();
  const cfg = getConfig();
  const { adminPassword, ...runtime } = db.settings;
  return {
    settings: { ...runtime, title: cfg.title, scale: cfg.scale },
    criteria: cfg.criteria,
    items: cfg.items,
    judges: cfg.judges,
    methods: METHODS,
  };
}

app.get('/api/admin/settings', requireAuth, (req, res) => {
  res.json(adminSettingsPayload());
});

app.put('/api/admin/settings', requireAuth, (req, res) => {
  const db = getDb();
  const cfg = getConfig();
  const { title, scale, method, bayesianPrior, trimRatio, judgeCode } = req.body || {};
  if (typeof title === 'string') cfg.title = title;
  if (typeof judgeCode === 'string' && judgeCode.trim()) db.settings.judgeCode = judgeCode.trim();
  if (scale && typeof scale === 'object') {
    const min = Number(scale.min), max = Number(scale.max), step = Number(scale.step);
    if ([min, max, step].some(Number.isNaN) || min >= max || step <= 0) {
      return res.status(400).json({ error: '点数段階の値が不正です（min<max, step>0）' });
    }
    cfg.scale = { min, max, step };
  }
  if (method && METHODS.some((m) => m.id === method)) db.settings.method = method;
  if (bayesianPrior !== undefined) db.settings.bayesianPrior = Math.max(0, Number(bayesianPrior) || 0);
  if (trimRatio !== undefined) db.settings.trimRatio = Math.max(0, Math.min(0.45, Number(trimRatio) || 0));
  save();
  saveConfig();
  res.json({ settings: adminSettingsPayload().settings });
});

app.post('/api/admin/password', requireAuth, (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 4) {
    return res.status(400).json({ error: 'パスワードは4文字以上にしてください' });
  }
  setAdminPassword(password);
  res.json({ ok: true });
});

// config.json を手で編集したときの再読み込み
app.post('/api/admin/reload-config', requireAuth, (req, res) => {
  try {
    reloadConfig();
    res.json(adminSettingsPayload());
  } catch (e) {
    res.status(400).json({ error: `config.json の読み込みに失敗しました: ${e.message}` });
  }
});

// 出し物 CRUD
app.post('/api/admin/items', requireAuth, (req, res) => {
  const cfg = getConfig();
  const { name, description } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '名前が必要です' });
  const item = { id: newId('i'), name: name.trim(), description: (description || '').trim() };
  cfg.items.push(item);
  saveConfig();
  res.json(item);
});

app.put('/api/admin/items/:id', requireAuth, (req, res) => {
  const cfg = getConfig();
  const item = cfg.items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: '見つかりません' });
  const { name, description } = req.body || {};
  if (typeof name === 'string' && name.trim()) item.name = name.trim();
  if (typeof description === 'string') item.description = description.trim();
  saveConfig();
  res.json(item);
});

app.delete('/api/admin/items/:id', requireAuth, (req, res) => {
  const db = getDb();
  const cfg = getConfig();
  const idx = cfg.items.findIndex((i) => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '見つかりません' });
  cfg.items.splice(idx, 1);
  db.votes = db.votes.filter((v) => v.itemId !== req.params.id);
  save();
  saveConfig();
  res.json({ ok: true });
});

// 採点項目 CRUD
app.post('/api/admin/criteria', requireAuth, (req, res) => {
  const cfg = getConfig();
  const { name, weight } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '名前が必要です' });
  const c = { id: newId('c'), name: name.trim(), weight: Number(weight) > 0 ? Number(weight) : 1 };
  cfg.criteria.push(c);
  saveConfig();
  res.json(c);
});

app.put('/api/admin/criteria/:id', requireAuth, (req, res) => {
  const cfg = getConfig();
  const c = cfg.criteria.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '見つかりません' });
  const { name, weight } = req.body || {};
  if (typeof name === 'string' && name.trim()) c.name = name.trim();
  if (weight !== undefined && Number(weight) > 0) c.weight = Number(weight);
  saveConfig();
  res.json(c);
});

app.delete('/api/admin/criteria/:id', requireAuth, (req, res) => {
  const cfg = getConfig();
  if (cfg.criteria.length <= 1) return res.status(400).json({ error: '採点項目は最低1つ必要です' });
  const idx = cfg.criteria.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '見つかりません' });
  cfg.criteria.splice(idx, 1);
  saveConfig();
  res.json({ ok: true });
});

// 審査員の登録・削除
app.post('/api/admin/judges', requireAuth, (req, res) => {
  const cfg = getConfig();
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: '名前が必要です' });
  if (cfg.judges.includes(name)) return res.status(400).json({ error: 'すでに登録されています' });
  cfg.judges.push(name);
  saveConfig();
  res.json({ ok: true, judges: cfg.judges });
});

app.delete('/api/admin/judges/:name', requireAuth, (req, res) => {
  const cfg = getConfig();
  const name = decodeURIComponent(req.params.name);
  const idx = cfg.judges.indexOf(name);
  if (idx === -1) return res.status(404).json({ error: '見つかりません' });
  cfg.judges.splice(idx, 1);
  saveConfig();
  res.json({ ok: true, judges: cfg.judges });
});

// 結果（順位）。全集計方法での順位も返し、比較できるようにする。
app.get('/api/admin/results', requireAuth, (req, res) => {
  const db = getDb();
  const cfg = getConfig();
  const buildFor = (voterType) => {
    const current = ranking(db.votes, cfg.items, cfg.criteria, db.settings, voterType);
    const byMethod = {};
    for (const m of METHODS) {
      byMethod[m.id] = ranking(db.votes, cfg.items, cfg.criteria, { ...db.settings, method: m.id }, voterType);
    }
    return { current, byMethod };
  };
  res.json({
    method: db.settings.method,
    methods: METHODS,
    judge: buildFor('judge'),
    visitor: buildFor('visitor'),
    all: buildFor(null),
    counts: {
      judgeVotes: db.votes.filter((v) => v.voterType === 'judge').length,
      visitorVotes: db.votes.filter((v) => v.voterType === 'visitor').length,
    },
  });
});

// 生データのエクスポート（CSV）
app.get('/api/admin/export.csv', requireAuth, (req, res) => {
  const db = getDb();
  const cfg = getConfig();
  const header = ['voterType', 'voterId', 'itemId', 'itemName', ...cfg.criteria.map((c) => c.name), 'createdAt'];
  const rows = db.votes.map((v) => {
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
});

// 投票データのリセット
app.delete('/api/admin/votes', requireAuth, (req, res) => {
  const db = getDb();
  db.votes = [];
  save();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n文化祭 採点アプリ 起動`);
  console.log(`  投票画面 : http://localhost:${PORT}/`);
  console.log(`  管理/結果: http://localhost:${PORT}/admin.html （初期パスワード: admin）`);
  console.log(`  他端末から: http://<このPCのIPアドレス>:${PORT}/\n`);
});
