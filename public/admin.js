// 管理・結果画面。全APIはトークン認証必須。
const $ = (sel) => document.querySelector(sel);
let token = sessionStorage.getItem('adminToken') || null;
let cache = { settings: null, criteria: [], items: [], methods: [] };
let voterFilter = 'judge';

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  setTimeout(() => { t.className = 'toast'; }, 2200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    token = null;
    sessionStorage.removeItem('adminToken');
    showLogin();
    throw new Error('認証切れです。再ログインしてください。');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || '通信エラー');
  return data;
}

// --- ログイン -------------------------------------------------------
function showLogin() {
  $('#loginCard').classList.remove('hidden');
  $('#adminArea').classList.add('hidden');
  $('#logoutBtn').classList.add('hidden');
}
function showAdmin() {
  $('#loginCard').classList.add('hidden');
  $('#adminArea').classList.remove('hidden');
  $('#logoutBtn').classList.remove('hidden');
}

$('#loginBtn').addEventListener('click', doLogin);
$('#password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ password: $('#password').value }),
    });
    token = data.token;
    sessionStorage.setItem('adminToken', token);
    $('#password').value = '';
    await boot();
  } catch (e) { toast(e.message, 'err'); }
}

$('#logoutBtn').addEventListener('click', () => {
  token = null;
  sessionStorage.removeItem('adminToken');
  showLogin();
});

// --- タブ切替 -------------------------------------------------------
$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  [...$('#tabs').children].forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.tab').forEach((t) => t.classList.add('hidden'));
  $(`#tab-${btn.dataset.tab}`).classList.remove('hidden');
  if (btn.dataset.tab === 'results') loadResults();
});

// --- 起動 -----------------------------------------------------------
async function boot() {
  showAdmin();
  const data = await api('/api/admin/settings');
  cache = data;
  fillSettingsForm();
  fillMethodSelect();
  renderItems();
  renderCriteria();
  await loadResults();
  await loadBackups();
}

function fillMethodSelect() {
  const sel = $('#methodSelect');
  sel.innerHTML = cache.methods.map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
  sel.value = cache.settings.method;
  updateMethodDesc();
}
function updateMethodDesc() {
  const m = cache.methods.find((x) => x.id === $('#methodSelect').value);
  $('#methodDesc').textContent = m ? m.desc : '';
}
$('#methodSelect').addEventListener('change', async () => {
  updateMethodDesc();
  try {
    await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ method: $('#methodSelect').value }) });
    cache.settings.method = $('#methodSelect').value;
    await loadResults();
    toast('集計方法を変更しました', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

// --- 結果 -----------------------------------------------------------
$('#voterFilter').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  voterFilter = btn.dataset.vt;
  [...$('#voterFilter').children].forEach((b) => b.classList.toggle('active', b === btn));
  renderRanking();
  renderCompare();
});

let resultsData = null;
async function loadResults() {
  try {
    resultsData = await api('/api/admin/results');
    $('#methodSelect').value = resultsData.method;
    updateMethodDesc();
    $('#choiceModeNote').classList.toggle('hidden', resultsData.visitorVoteMode !== 'choice');
    $('#statJudge').textContent = resultsData.counts.judgeVotes;
    $('#statVisitor').textContent = resultsData.counts.visitorVotes;
    $('#statItems').textContent = cache.items.length;
    renderRanking();
    renderCompare();
    renderJudgeMatrix();
  } catch (e) { toast(e.message, 'err'); }
}

function rankBadge(rank) {
  const cls = rank === 1 ? 'r1' : rank === 2 ? 'r2' : rank === 3 ? 'r3' : '';
  return `<span class="rank-badge ${cls}">${rank}</span>`;
}

const isChoiceVisitor = () => resultsData?.visitorVoteMode === 'choice' && voterFilter === 'visitor';

function renderRanking() {
  const rows = resultsData[voterFilter].current;
  if (!rows.length) {
    $('#rankingTable').innerHTML = '<div class="empty">まだ出し物がありません。「出し物」タブから追加してください。</div>';
    return;
  }
  const scores = rows.map((r) => r.score);
  const maxS = Math.max(...scores);
  const minS = Math.min(...scores, 0);
  const span = maxS - minS || 1;
  const scoreLabel = isChoiceVisitor() ? '得票数' : 'スコア';

  let html = `<table><thead><tr><th style="width:56px">順位</th><th>出し物</th><th class="score-cell">${scoreLabel}</th><th class="num" style="width:64px">票数</th></tr></thead><tbody>`;
  for (const r of rows) {
    const width = Math.max(3, ((r.score - minS) / span) * 100);
    html += `<tr>
      <td>${rankBadge(r.rank)}</td>
      <td><strong>${escapeHtml(r.name)}</strong></td>
      <td class="score-cell"><div class="score-line"><div class="bar"><div style="width:${width}%"></div></div><span class="val">${r.score}</span></div></td>
      <td class="num">${r.count}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  $('#rankingTable').innerHTML = html;
}

function renderCompare() {
  const group = resultsData[voterFilter];
  if (!cache.items.length) { $('#compareTable').innerHTML = ''; return; }
  if (isChoiceVisitor()) {
    $('#compareTable').innerHTML = '<div class="empty">来場者は選択方式のため、集計方法による順位の違いはありません（得票数で順位づけされます）。</div>';
    return;
  }
  const rankMaps = {};
  for (const m of cache.methods) {
    rankMaps[m.id] = new Map(group.byMethod[m.id].map((r) => [r.itemId, r.rank]));
  }
  let html = '<table><thead><tr><th>出し物</th>';
  for (const m of cache.methods) {
    const active = m.id === cache.settings.method;
    html += `<th class="num"${active ? ' style="color:var(--primary)"' : ''}>${m.name}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (const r of group.current) {
    html += `<tr><td><strong>${escapeHtml(r.name)}</strong></td>`;
    for (const m of cache.methods) {
      const rank = rankMaps[m.id].get(r.itemId);
      const active = m.id === cache.settings.method;
      html += `<td class="num"${active ? ' style="font-weight:800;color:var(--primary)"' : ''}>${rank ?? '-'}位</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  $('#compareTable').innerHTML = html;
}

// --- 出し物 ---------------------------------------------------------
$('#addItem').addEventListener('click', async () => {
  const name = $('#itemName').value.trim();
  if (!name) return toast('名前を入力してください', 'err');
  try {
    await api('/api/admin/items', { method: 'POST', body: JSON.stringify({ name, description: $('#itemDesc').value }) });
    $('#itemName').value = ''; $('#itemDesc').value = '';
    await refreshMeta();
    toast('追加しました', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

function renderItems() {
  const box = $('#itemsList');
  if (!cache.items.length) { box.innerHTML = '<div class="empty">まだありません。</div>'; return; }
  box.innerHTML = '';
  for (const item of cache.items) {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `<div class="grow"><strong>${escapeHtml(item.name)}</strong>` +
      (item.description ? ` <span class="muted">${escapeHtml(item.description)}</span>` : '') + '</div>';
    const edit = document.createElement('button');
    edit.className = 'ghost'; edit.textContent = '編集';
    edit.onclick = async () => {
      const name = prompt('名前', item.name); if (name === null) return;
      const description = prompt('説明', item.description || ''); if (description === null) return;
      try { await api(`/api/admin/items/${item.id}`, { method: 'PUT', body: JSON.stringify({ name, description }) }); await refreshMeta(); }
      catch (e) { toast(e.message, 'err'); }
    };
    const del = document.createElement('button');
    del.className = 'danger'; del.textContent = '削除';
    del.onclick = async () => {
      if (!confirm(`「${item.name}」を削除しますか？この出し物への投票も消えます。`)) return;
      try { await api(`/api/admin/items/${item.id}`, { method: 'DELETE' }); await refreshMeta(); toast('削除しました', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    };
    row.append(edit, del);
    box.appendChild(row);
  }
}

// --- 採点項目 -------------------------------------------------------
$('#addCrit').addEventListener('click', async () => {
  const name = $('#critName').value.trim();
  if (!name) return toast('項目名を入力してください', 'err');
  try {
    await api('/api/admin/criteria', { method: 'POST', body: JSON.stringify({ name, weight: $('#critWeight').value }) });
    $('#critName').value = ''; $('#critWeight').value = '1';
    await refreshMeta();
    toast('追加しました', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

function renderCriteria() {
  const box = $('#critList');
  box.innerHTML = '';
  for (const c of cache.criteria) {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `<div class="grow"><strong>${escapeHtml(c.name)}</strong> <span class="muted">重み ${c.weight}</span></div>`;
    const del = document.createElement('button');
    del.className = 'danger'; del.textContent = '削除';
    del.onclick = async () => {
      if (!confirm(`採点項目「${c.name}」を削除しますか？`)) return;
      try { await api(`/api/admin/criteria/${c.id}`, { method: 'DELETE' }); await refreshMeta(); toast('削除しました', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    };
    row.append(del);
    box.appendChild(row);
  }
}

// --- 審査員×出し物の採点表 -------------------------------------------
function renderJudgeMatrix() {
  const box = $('#judgeMatrix');
  const names = resultsData.judgeNames || [];
  if (!names.length || !cache.items.length) {
    box.innerHTML = '<div class="empty">まだ採点委員の採点がありません。</div>';
    return;
  }
  $('#judgeMatrixLead').textContent =
    `太字が総合点（重み付き合計）、カッコ内は項目別の点数（${cache.criteria.map((c) => c.name).join(' / ')}）。`;
  let html = '<table><thead><tr><th>出し物</th>';
  for (const n of names) html += `<th class="num">${escapeHtml(n)}</th>`;
  html += '</tr></thead><tbody>';
  for (const item of cache.items) {
    html += `<tr><td><strong>${escapeHtml(item.name)}</strong></td>`;
    for (const n of names) {
      const cell = resultsData.judgeTable?.[n]?.[item.id];
      if (!cell) {
        html += '<td class="num" style="color:var(--muted)">-</td>';
      } else {
        const detail = cache.criteria.map((c) => cell.scores?.[c.id] ?? '-').join(' / ');
        html += `<td class="num"><strong>${cell.total}</strong><br><span class="muted" style="font-size:.78rem">(${detail})</span></td>`;
      }
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  box.innerHTML = html;
}

// --- 設定 -----------------------------------------------------------
function renderVotingToggle() {
  const open = cache.settings.votingOpen !== false;
  [...$('#votingToggle').children].forEach((b) => {
    b.classList.toggle('active', (b.dataset.open === 'true') === open);
  });
  $('#votingToggleNote').textContent = open
    ? '現在は投票を受け付けています。'
    : '現在は投票を停止中です。投票画面には「受け付けていません」と表示されます。';
}

$('#votingToggle').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const open = btn.dataset.open === 'true';
  if ((cache.settings.votingOpen !== false) === open) return;
  try {
    await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ votingOpen: open }) });
    cache.settings.votingOpen = open;
    renderVotingToggle();
    toast(open ? '投票の受付を開始しました' : '投票の受付を停止しました', 'ok');
  } catch (e2) { toast(e2.message, 'err'); }
});

function renderVisitorMode() {
  const mode = cache.settings.visitorVoteMode === 'choice' ? 'choice' : 'score';
  [...$('#visitorModeToggle').children].forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  $('#choiceMaxWrap').classList.toggle('hidden', mode !== 'choice');
  $('#visitorModeNote').textContent = mode === 'choice'
    ? '来場者はお気に入りの出し物を選ぶだけで投票できます。1票=1点の得票数で順位づけされ、採点項目・重みは使われません。'
    : '来場者も採点委員と同じように、採点項目ごとに点数をつけて投票します。';
}

$('#visitorModeToggle').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const mode = btn.dataset.mode;
  if ((cache.settings.visitorVoteMode === 'choice' ? 'choice' : 'score') === mode) return;
  try {
    await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ visitorVoteMode: mode }) });
    cache.settings.visitorVoteMode = mode;
    renderVisitorMode();
    await loadResults();
    toast(mode === 'choice' ? '来場者の投票を「選択方式」にしました' : '来場者の投票を「点数方式」にしました', 'ok');
  } catch (e2) { toast(e2.message, 'err'); }
});

$('#choiceMaxSel').addEventListener('change', async () => {
  const choiceMax = Number($('#choiceMaxSel').value);
  try {
    await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ choiceMax }) });
    cache.settings.choiceMax = choiceMax;
    toast(`1人が選べる数を${choiceMax}つにしました`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

// --- 共有用URL --------------------------------------------------------
$('#voteUrl').value = location.origin + '/';
$('#adminUrl').value = location.origin + '/admin.html';

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label}をコピーしました`, 'ok');
  } catch {
    toast('コピーできませんでした。URLを長押し（選択）してコピーしてください', 'err');
  }
}
$('#copyVoteUrl').addEventListener('click', () => copyText($('#voteUrl').value, '採点URL'));
$('#copyAdminUrl').addEventListener('click', () => copyText($('#adminUrl').value, '管理URL'));

function fillSettingsForm() {
  const s = cache.settings;
  renderVotingToggle();
  renderVisitorMode();
  setSelectValue($('#choiceMaxSel'), s.choiceMax ?? 3);
  $('#setTitle').value = s.title;
  $('#setJudgeCode').value = s.judgeCode || '';
  $('#newPassword').value = s.adminPassword || '';
  $('#scaleMin').value = s.scale.min;
  $('#scaleMax').value = s.scale.max;
  $('#scaleStep').value = s.scale.step;
  setSelectValue($('#bayesPrior'), s.bayesianPrior);
  setSelectValue($('#trimRatio'), s.trimRatio);
}

// プルダウンにない値（過去に手入力した等）は選択肢として追加してから選ぶ
function setSelectValue(sel, value) {
  const v = String(value);
  if (![...sel.options].some((o) => o.value === v)) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = `${v}（現在の設定）`;
    sel.appendChild(opt);
  }
  sel.value = v;
}

$('#saveSettings').addEventListener('click', async () => {
  const payload = {
    title: $('#setTitle').value,
    judgeCode: $('#setJudgeCode').value,
    scale: { min: Number($('#scaleMin').value), max: Number($('#scaleMax').value), step: Number($('#scaleStep').value) },
    bayesianPrior: Number($('#bayesPrior').value),
    trimRatio: Number($('#trimRatio').value),
  };
  try {
    const data = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(payload) });
    cache.settings = { ...cache.settings, ...data.settings };
    await loadResults();
    toast('設定を保存しました', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

$('#changePw').addEventListener('click', async () => {
  const password = $('#newPassword').value;
  try {
    await api('/api/admin/password', { method: 'POST', body: JSON.stringify({ password }) });
    cache.settings.adminPassword = password;
    toast('パスワードを変更しました', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

$('#reloadConfigBtn').addEventListener('click', async () => {
  try {
    const data = await api('/api/admin/reload-config', { method: 'POST' });
    cache = data;
    fillSettingsForm();
    fillMethodSelect();
    renderItems();
    renderCriteria();
    await loadResults();
    toast('config.json を再読み込みしました', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

$('#exportBtn').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/admin/export.csv', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('出力に失敗しました');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'votes.csv';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) { toast(e.message, 'err'); }
});

$('#resetVotes').addEventListener('click', async () => {
  if (!confirm('全ての投票データを削除します。よろしいですか？\n（直近2回分のリセットは「リセットの復元」から元に戻せます）')) return;
  try {
    const data = await api('/api/admin/votes', { method: 'DELETE' });
    renderBackups(data.backups);
    await loadResults();
    toast('リセットしました', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

// --- リセットの復元 ---------------------------------------------------
function renderBackups(backups) {
  const box = $('#backupList');
  if (!backups || !backups.length) {
    box.innerHTML = '<div class="empty">復元できるバックアップはまだありません。</div>';
    return;
  }
  box.innerHTML = '';
  for (const b of backups) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.cssText = 'align-items:center;gap:12px;margin-top:10px;flex-wrap:wrap';
    const label = document.createElement('span');
    label.className = 'muted';
    label.textContent = `${b.slot === 1 ? '直前のリセット' : '2つ前のリセット'} · ${new Date(b.at).toLocaleString('ja-JP')} · ${b.count}票`;
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.type = 'button';
    btn.textContent = 'この時点に復元';
    btn.addEventListener('click', async () => {
      if (!confirm(`リセット時点の ${b.count}票 に戻します。今ある票は上書きされます。よろしいですか？`)) return;
      try {
        const data = await api(`/api/admin/vote-backups/${b.slot}/restore`, { method: 'POST' });
        await loadResults();
        toast(`${data.count}票を復元しました`, 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });
    row.appendChild(label);
    row.appendChild(btn);
    box.appendChild(row);
  }
}

async function loadBackups() {
  try {
    renderBackups((await api('/api/admin/vote-backups')).backups);
  } catch { /* 表示できなくても他の機能に影響させない */ }
}

async function refreshMeta() {
  const data = await api('/api/admin/settings');
  cache = data;
  renderItems();
  renderCriteria();
  fillMethodSelect();
  if (!$('#tab-results').classList.contains('hidden')) await loadResults();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// 既存トークンがあれば自動ログイン
if (token) boot().catch(() => showLogin());
else showLogin();
