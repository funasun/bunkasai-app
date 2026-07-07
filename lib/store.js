import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
// マスターデータ（出し物・採点項目・審査員・点数段階）。直接編集できるようリポジトリ直下に置く
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt] = stored.split(':');
  const candidate = hashPassword(password, salt);
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

function defaultConfig() {
  return {
    title: '文化祭 採点',
    // 点数段階（min/max/step）
    scale: { min: 1, max: 5, step: 1 },
    criteria: [{ id: 'c1', name: '総合', weight: 1 }],
    items: [],
    // 審査員として採点できるのはここに登録された名前だけ
    judges: [],
  };
}

function defaultDb() {
  return {
    settings: {
      // 現在の集計方法: sum | average | zscore | bayesian | trimmed
      method: 'zscore',
      bayesianPrior: 5,
      trimRatio: 0.1,
      // 初期パスワード: admin（管理画面で変更してください）
      adminPassword: hashPassword('admin'),
      judgeCode: genJudgeCode(),
    },
    votes: [],
  };
}

let db = null;
let config = null;

function atomicWrite(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// 旧形式（items/criteria/settings.titleがdb.jsonにある）からの移行
function migrateOldDb(old) {
  const s = old.settings || {};
  const judgesFromVotes = [...new Set(
    (old.votes || [])
      .filter((v) => v.voterType === 'judge' && typeof v.voterId === 'string')
      .map((v) => v.voterId.replace(/^judge:/, '')),
  )];
  const migratedConfig = {
    title: s.title || '文化祭 採点',
    scale: s.scale || { min: 1, max: 5, step: 1 },
    criteria: old.criteria || defaultConfig().criteria,
    items: old.items || [],
    judges: judgesFromVotes,
  };
  const migratedDb = {
    settings: {
      method: s.method || 'zscore',
      bayesianPrior: s.bayesianPrior ?? 5,
      trimRatio: s.trimRatio ?? 0.1,
      adminPassword: s.adminPassword || hashPassword('admin'),
      judgeCode: s.judgeCode || genJudgeCode(),
    },
    votes: old.votes || [],
  };
  return { migratedConfig, migratedDb };
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

export function load() {
  if (db && config) return;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (raw.items || raw.criteria) {
      const { migratedConfig, migratedDb } = migrateOldDb(raw);
      db = migratedDb;
      atomicWrite(DB_PATH, db);
      if (!fs.existsSync(CONFIG_PATH)) atomicWrite(CONFIG_PATH, migratedConfig);
    } else {
      db = raw;
    }
  } else {
    db = defaultDb();
    atomicWrite(DB_PATH, db);
  }

  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    // 手書き編集で欠けたフィールドを補完
    config = { ...defaultConfig(), ...config };
  } else {
    config = defaultConfig();
  }
  if (ensureIds(config)) saveConfig();
  if (!fs.existsSync(CONFIG_PATH)) saveConfig();
}

export function getDb() { load(); return db; }
export function getConfig() { load(); return config; }

export function save() { if (db) atomicWrite(DB_PATH, db); }
export function saveConfig() { if (config) atomicWrite(CONFIG_PATH, config); }

// config.json を手で編集したあと、再起動せずに反映するため
export function reloadConfig() {
  config = null;
  if (fs.existsSync(CONFIG_PATH)) {
    config = { ...defaultConfig(), ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    if (ensureIds(config)) saveConfig();
  } else {
    config = defaultConfig();
    saveConfig();
  }
  return config;
}

export function setAdminPassword(password) {
  load();
  db.settings.adminPassword = hashPassword(password);
  save();
}
