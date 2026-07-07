// 集計ロジック。
// 「全員が全てに投票するわけではない」「審査員ごとの甘辛の偏り」「少数票の偶然」を
// 補正するため、複数の集計方法を用意し切り替えられるようにしている。

export const METHODS = [
  { id: 'combined', name: '総合補正（万能・おすすめ）', desc: '甘辛の標準化 → 上下の外れ値除去 → 少数票の補正、をまとめて適用。迷ったらこれ。' },
  { id: 'sum',      name: '単純合計',        desc: '全票の合計。票数が多い出し物ほど有利（偏りは補正しない）。' },
  { id: 'average',  name: '平均',            desc: '1票あたりの平均。票数のばらつきを補正。' },
  { id: 'zscore',   name: '正規化平均(偏差)', desc: '採点者ごとの甘辛（厳しい/甘い採点）を標準化して補正。' },
  { id: 'bayesian', name: 'ベイズ平均',       desc: '票数が少ない出し物を全体平均へ引き寄せ、偶然の高評価を抑制。' },
  { id: 'trimmed',  name: 'トリム平均',       desc: '上下の外れ値を除いた平均。極端な票の影響を軽減。' },
];

// 1票の合計点（採点項目を重み付きで合算）
export function voteTotal(vote, criteria) {
  let total = 0;
  for (const c of criteria) {
    const v = vote.scores?.[c.id];
    if (typeof v === 'number' && !Number.isNaN(v)) {
      total += v * (c.weight ?? 1);
    }
  }
  return total;
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr, m) {
  if (arr.length < 2) return 0;
  const variance = arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

// itemId -> [ { voterId, total } ] を作る
function collect(votes, criteria) {
  const byItem = new Map();
  for (const vote of votes) {
    const total = voteTotal(vote, criteria);
    if (!byItem.has(vote.itemId)) byItem.set(vote.itemId, []);
    byItem.get(vote.itemId).push({ voterId: vote.voterId, total });
  }
  return byItem;
}

// 採点者ごとの甘辛を標準化した z 値を itemId ごとに集める。
// 各投票者の全採点から平均・標準偏差を出し、z = (total - 平均) / 標準偏差 に変換。
function zValuesByItem(byItem) {
  const byVoter = new Map();
  for (const [itemId, entries] of byItem) {
    for (const e of entries) {
      if (!byVoter.has(e.voterId)) byVoter.set(e.voterId, []);
      byVoter.get(e.voterId).push({ itemId, total: e.total });
    }
  }
  const zByItem = new Map();
  for (const [, entries] of byVoter) {
    const totals = entries.map((e) => e.total);
    const m = mean(totals);
    const sd = stddev(totals, m);
    for (const e of entries) {
      // 1つしか投票していない等でsd=0の投票者は中立(0)として寄与
      const z = sd > 0 ? (e.total - m) / sd : 0;
      if (!zByItem.has(e.itemId)) zByItem.set(e.itemId, []);
      zByItem.get(e.itemId).push(z);
    }
  }
  return zByItem;
}

// 集計方法ごとにスコアを算出。
// 戻り値: itemId -> { score, count }
export function scoreItems(votes, items, criteria, settings) {
  const method = settings.method || 'zscore';
  const byItem = collect(votes, criteria);
  const result = new Map();

  if (method === 'sum' || method === 'average') {
    for (const item of items) {
      const entries = byItem.get(item.id) || [];
      const totals = entries.map((e) => e.total);
      const score = method === 'sum'
        ? totals.reduce((a, b) => a + b, 0)
        : mean(totals);
      result.set(item.id, { score, count: entries.length });
    }
    return result;
  }

  if (method === 'trimmed') {
    const ratio = clamp(settings.trimRatio ?? 0.1, 0, 0.45);
    for (const item of items) {
      const entries = byItem.get(item.id) || [];
      const totals = entries.map((e) => e.total).sort((a, b) => a - b);
      const drop = Math.floor(totals.length * ratio);
      const kept = drop > 0 ? totals.slice(drop, totals.length - drop) : totals;
      result.set(item.id, { score: mean(kept.length ? kept : totals), count: entries.length });
    }
    return result;
  }

  if (method === 'bayesian') {
    // ベイズ平均（縮小推定）: (C*m + Σx) / (C + n)
    // m = 全体平均、C = 事前サンプル数
    const allTotals = [];
    for (const entries of byItem.values()) for (const e of entries) allTotals.push(e.total);
    const globalMean = mean(allTotals);
    const C = Math.max(0, settings.bayesianPrior ?? 5);
    for (const item of items) {
      const entries = byItem.get(item.id) || [];
      const sum = entries.reduce((a, e) => a + e.total, 0);
      const n = entries.length;
      const score = (C * globalMean + sum) / (C + n || 1);
      result.set(item.id, { score, count: n });
    }
    return result;
  }

  if (method === 'zscore') {
    const zByItem = zValuesByItem(byItem);
    for (const item of items) {
      const zs = zByItem.get(item.id) || [];
      result.set(item.id, { score: mean(zs), count: (byItem.get(item.id) || []).length });
    }
    return result;
  }

  if (method === 'combined') {
    // 万能型: ①甘辛の標準化(z) → ②上下トリムで外れ値除去 → ③ベイズ縮小で少数票を補正
    const ratio = clamp(settings.trimRatio ?? 0.1, 0, 0.45);
    const C = Math.max(0, settings.bayesianPrior ?? 5);
    const zByItem = zValuesByItem(byItem);
    const allZ = [];
    for (const zs of zByItem.values()) allZ.push(...zs);
    const globalMean = mean(allZ);
    for (const item of items) {
      const zs = (zByItem.get(item.id) || []).slice().sort((a, b) => a - b);
      const drop = Math.floor(zs.length * ratio);
      const kept = drop > 0 ? zs.slice(drop, zs.length - drop) : zs;
      const use = kept.length ? kept : zs;
      const sum = use.reduce((a, b) => a + b, 0);
      const score = (C * globalMean + sum) / (C + use.length || 1);
      result.set(item.id, { score, count: (byItem.get(item.id) || []).length });
    }
    return result;
  }

  // 未知のメソッドは平均にフォールバック
  for (const item of items) {
    const entries = byItem.get(item.id) || [];
    result.set(item.id, { score: mean(entries.map((e) => e.total)), count: entries.length });
  }
  return result;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// 順位表を作る。voterType で審査員/来場者を絞り込む。
export function ranking(votes, items, criteria, settings, voterType) {
  const filtered = voterType ? votes.filter((v) => v.voterType === voterType) : votes;
  const scored = scoreItems(filtered, items, criteria, settings);
  const rows = items.map((item) => {
    const s = scored.get(item.id) || { score: 0, count: 0 };
    return { itemId: item.id, name: item.name, score: s.score, count: s.count };
  });
  rows.sort((a, b) => b.score - a.score || b.count - a.count);
  let rank = 0;
  let prevScore = null;
  rows.forEach((row, i) => {
    if (prevScore === null || row.score !== prevScore) {
      rank = i + 1;
      prevScore = row.score;
    }
    row.rank = rank;
    row.score = Number(row.score.toFixed(4));
  });
  return rows;
}
