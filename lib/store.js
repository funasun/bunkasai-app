import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
// マスターデータ（出し物・採点項目・審査員・点数段階）。直接編集できるようリポジトリ直下に置く
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

// Vercel等では Upstash Redis に保存（ファイルは残らないため）。ローカルは従来通りファイル保存
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
export const usingRedis = Boolean(REDIS_URL && REDIS_TOKEN);

const K = {
  config: 'bunkasai:config',
  settings: 'bunkasai:settings',
  votes: 'bunkasai:votes',
  voteBackup: (n) => `bunkasai:votes_backup:${n}`,
  token: (t) => `bunkasai:token:${t}`,
};

const SESSION_TTL_SEC = 60 * 60 * 8; // 8時間

async function redis(...cmd) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Redis: ${data.error || res.status}`);
  return data.result;
}

// --- パスワード・ID ---------------------------------------------------

// 旧バージョンはscryptハッシュで保存していた。現在は管理画面で表示できるよう平文保存
// （ログイン成功時に自動で平文へ移行する）
const LEGACY_HASH_RE = /^[0-9a-f]{32}:[0-9a-f]{128}$/;

export function isLegacyHash(stored) {
  return typeof stored === 'string' && LEGACY_HASH_RE.test(stored);
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  let candidate = String(password);
  if (isLegacyHash(stored)) {
    const [salt] = stored.split(':');
    candidate = `${salt}:${crypto.scryptSync(candidate, salt, 64).toString('hex')}`;
  }
  const a = Buffer.from(candidate);
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function genJudgeCode() {
  // 端末で打ちやすい6桁の数字コード
  return String(crypto.randomInt(100000, 1000000));
}

export function newId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

// --- 既定値 -----------------------------------------------------------

function defaultConfig() {
  return {
    title: '文化祭 採点',
    scale: { min: 1, max: 5, step: 1 },
    criteria: [{ id: 'c1', name: '総合', weight: 1 }],
    items: [],
  };
}

function defaultSettings() {
  return {
    method: 'zscore',
    bayesianPrior: 5,
    trimRatio: 0.1,
    votingOpen: true,
    adminPassword: process.env.ADMIN_PASSWORD || 'admin',
    judgeCode: process.env.JUDGE_CODE || genJudgeCode(),
  };
}

function ensureIds(cfg) {
  let changed = false;
  for (const c of cfg.criteria) {
    if (!c.id) { c.id = newId('c'); changed = true; }
    if (!(Number(c.weight) > 0)) { c.weight = 1; changed = true; }
  }
  for (const i of cfg.items) {
    if (!i.id) { i.id = newId('i'); changed = true; }
  }
  return changed;
}

// リポジトリ同梱の config.json（Redisモードでは初期値・再読み込み元として使う）
function readBundledConfig() {
  let cfg = defaultConfig();
  if (fs.existsSync(CONFIG_PATH)) {
    cfg = { ...defaultConfig(), ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  }
  ensureIds(cfg);
  return cfg;
}

// --- ファイル保存（ローカル用） ---------------------------------------

let fileDb = null;
let fileConfig = null;
const memTokens = new Map(); // token -> expiry(ms)

function atomicWrite(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// 旧形式（items/criteria/settings.titleがdb.jsonにある）からの移行
function migrateOldDb(old) {
  const s = old.settings || {};
  const migratedConfig = {
    title: s.title || '文化祭 採点',
    scale: s.scale || { min: 1, max: 5, step: 1 },
    criteria: old.criteria || defaultConfig().criteria,
    items: old.items || [],
  };
  const migratedDb = {
    settings: {
      method: s.method || 'zscore',
      bayesianPrior: s.bayesianPrior ?? 5,
      trimRatio: s.trimRatio ?? 0.1,
      adminPassword: s.adminPassword || 'admin',
      judgeCode: s.judgeCode || genJudgeCode(),
    },
    votes: old.votes || [],
  };
  return { migratedConfig, migratedDb };
}

function fileLoad() {
  if (fileDb && fileConfig) return;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (raw.items || raw.criteria) {
      const { migratedConfig, migratedDb } = migrateOldDb(raw);
      fileDb = migratedDb;
      atomicWrite(DB_PATH, fileDb);
      if (!fs.existsSync(CONFIG_PATH)) atomicWrite(CONFIG_PATH, migratedConfig);
    } else {
      fileDb = raw;
    }
  } else {
    fileDb = { settings: defaultSettings(), votes: [] };
    atomicWrite(DB_PATH, fileDb);
  }

  fileConfig = readBundledConfig();
  if (!fs.existsSync(CONFIG_PATH)) atomicWrite(CONFIG_PATH, fileConfig);
}

// --- Redis初期化 -------------------------------------------------------

let redisInitDone = false;
async function ensureRedisInit() {
  if (redisInitDone) return;
  const [s, c] = await Promise.all([redis('GET', K.settings), redis('GET', K.config)]);
  if (!s) await redis('SET', K.settings, JSON.stringify(defaultSettings()), 'NX');
  if (!c) await redis('SET', K.config, JSON.stringify(readBundledConfig()), 'NX');
  redisInitDone = true;
}

// --- 公開API（すべて非同期） -------------------------------------------

export async function getConfig() {
  if (usingRedis) {
    await ensureRedisInit();
    return JSON.parse(await redis('GET', K.config));
  }
  fileLoad();
  return fileConfig;
}

export async function saveConfig(cfg) {
  if (usingRedis) {
    await redis('SET', K.config, JSON.stringify(cfg));
    return;
  }
  fileConfig = cfg;
  atomicWrite(CONFIG_PATH, cfg);
}

// config.json を編集（ローカル: 手編集 / Vercel: push・再デプロイ）したあとの再読み込み
export async function reloadConfig() {
  const cfg = readBundledConfig();
  if (usingRedis) {
    await redis('SET', K.config, JSON.stringify(cfg));
  } else {
    fileConfig = cfg;
    atomicWrite(CONFIG_PATH, cfg);
  }
  return cfg;
}

export async function getSettings() {
  if (usingRedis) {
    await ensureRedisInit();
    return JSON.parse(await redis('GET', K.settings));
  }
  fileLoad();
  return fileDb.settings;
}

export async function saveSettings(settings) {
  if (usingRedis) {
    await redis('SET', K.settings, JSON.stringify(settings));
    return;
  }
  fileLoad();
  fileDb.settings = settings;
  atomicWrite(DB_PATH, fileDb);
}

export async function setAdminPassword(password) {
  const settings = await getSettings();
  settings.adminPassword = String(password);
  await saveSettings(settings);
}

// --- 票 ----------------------------------------------------------------

const voteField = (v) => `${v.voterType}|${v.voterId}|${v.itemId}`;

export async function listVotes() {
  if (usingRedis) {
    const flat = await redis('HGETALL', K.votes);
    if (!flat) return [];
    const values = Array.isArray(flat)
      ? flat.filter((_, idx) => idx % 2 === 1)
      : Object.values(flat);
    return values.map((v) => JSON.parse(v));
  }
  fileLoad();
  return fileDb.votes;
}

// 同じ投票者×出し物は上書き（二重投票防止）
export async function putVote({ voterType, voterId, itemId, scores }) {
  if (usingRedis) {
    const field = voteField({ voterType, voterId, itemId });
    const prevRaw = await redis('HGET', K.votes, field);
    const prev = prevRaw ? JSON.parse(prevRaw) : null;
    const vote = prev
      ? { ...prev, scores, updatedAt: new Date().toISOString() }
      : { id: newId('v'), voterType, voterId, itemId, scores, createdAt: new Date().toISOString() };
    await redis('HSET', K.votes, field, JSON.stringify(vote));
    return vote;
  }
  fileLoad();
  const existing = fileDb.votes.find(
    (v) => v.voterType === voterType && v.voterId === voterId && v.itemId === itemId,
  );
  if (existing) {
    existing.scores = scores;
    existing.updatedAt = new Date().toISOString();
    atomicWrite(DB_PATH, fileDb);
    return existing;
  }
  const vote = { id: newId('v'), voterType, voterId, itemId, scores, createdAt: new Date().toISOString() };
  fileDb.votes.push(vote);
  atomicWrite(DB_PATH, fileDb);
  return vote;
}

export async function deleteVotesForItem(itemId) {
  if (usingRedis) {
    const votes = await listVotes();
    const fields = votes.filter((v) => v.itemId === itemId).map(voteField);
    if (fields.length) await redis('HDEL', K.votes, ...fields);
    return;
  }
  fileLoad();
  fileDb.votes = fileDb.votes.filter((v) => v.itemId !== itemId);
  atomicWrite(DB_PATH, fileDb);
}

// リセット時は直近2世代のバックアップを残し、操作ミスから復元できるようにする
export async function clearVotes() {
  const votes = await listVotes();
  if (votes.length) {
    const snapshot = JSON.stringify({ at: new Date().toISOString(), votes });
    if (usingRedis) {
      const prev = await redis('GET', K.voteBackup(1));
      if (prev) await redis('SET', K.voteBackup(2), prev);
      await redis('SET', K.voteBackup(1), snapshot);
    } else {
      fileLoad();
      fileDb.voteBackups = [JSON.parse(snapshot), ...(fileDb.voteBackups || [])].slice(0, 2);
    }
  }
  if (usingRedis) {
    await redis('DEL', K.votes);
    return;
  }
  fileLoad();
  fileDb.votes = [];
  atomicWrite(DB_PATH, fileDb);
}

async function readVoteBackup(slot) {
  if (usingRedis) {
    const raw = await redis('GET', K.voteBackup(slot));
    return raw ? JSON.parse(raw) : null;
  }
  fileLoad();
  return (fileDb.voteBackups || [])[slot - 1] || null;
}

export async function listVoteBackups() {
  const out = [];
  for (const slot of [1, 2]) {
    const b = await readVoteBackup(slot);
    if (b) out.push({ slot, at: b.at, count: b.votes.length });
  }
  return out;
}

// バックアップの時点の票に置き換える（現在の票は破棄）
export async function restoreVoteBackup(slot) {
  const b = await readVoteBackup(slot);
  if (!b) return null;
  if (usingRedis) {
    await redis('DEL', K.votes);
    if (b.votes.length) {
      const args = ['HSET', K.votes];
      for (const v of b.votes) args.push(voteField(v), JSON.stringify(v));
      await redis(...args);
    }
    return b.votes.length;
  }
  fileLoad();
  fileDb.votes = b.votes;
  atomicWrite(DB_PATH, fileDb);
  return b.votes.length;
}

// --- 認証トークン（Redisならサーバーレスでも共有される） -----------------

export async function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  if (usingRedis) {
    await redis('SET', K.token(token), '1', 'EX', SESSION_TTL_SEC);
  } else {
    memTokens.set(token, Date.now() + SESSION_TTL_SEC * 1000);
  }
  return token;
}

export async function isValidToken(token) {
  if (!token) return false;
  if (usingRedis) return (await redis('EXISTS', K.token(token))) === 1;
  const exp = memTokens.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { memTokens.delete(token); return false; }
  return true;
}
