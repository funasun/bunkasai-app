// 管理・結果画面。全APIはトークン認証必須。
const $ = (sel) => document.querySelector(sel);
let token = sessionStorage.getItem('adminToken') || null;
let cache = { settings: null, criteria: [], items: [], judges: [], methods: [] };
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
  renderJudges();
  await loadResults();
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
    $('#statJudge').textContent = resultsData.counts.judgeVotes;
    $('#statVisitor').textContent = resultsData.counts.visitorVotes;
    $('#statItems').textContent = cache.items.length;
    renderRanking();
    renderCompare();
  } catch (e) { toast(e.message, 'err'); }
}

function rankBadge(rank) {
  const cls = rank === 1 ? 'r1' : rank === 2 ? 'r2' : rank === 3 ? 'r3' : '';
  return `<span class="rank-badge ${cls}">${rank}</span>`;
}

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

  let html = '<table><thead><tr><th style="width:56px">順位</th><th>出し物</th><th class="score-cell">スコア</th><th class="num" style="width:64px">票数</th></tr></thead><tbody>';
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

// --- 審査員 ---------------------------------------------------------
$('#addJudge').addEventListener('click', async () => {
  const name = $('#judgeNewName').value.trim();
  if (!name) return toast('名前を入力してください', 'err');
  try {
    await api('/api/admin/judges', { method: 'POST', body: JSON.stringify({ name }) });
    $('#judgeNewName').value = '';
    await refreshMeta();
    toast('登録しました', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});
$('#judgeNewName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#addJudge').click(); });

function renderJudges() {
  const box = $('#judgesList');
  if (!cache.judges.length) { box.innerHTML = '<div class="empty">まだ登録されていません。審査員を登録すると投票画面で選べるようになります。</div>'; return; }
  box.innerHTML = '';
  for (const name of cache.judges) {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `<div class="grow"><strong>${escapeHtml(name)}</strong></div>`;
    const del = document.createElement('button');
    del.className = 'danger'; del.textContent = '削除';
    del.onclick = async () => {
      if (!confirm(`審査員「${name}」を削除しますか？（過去の票は残ります）`)) return;
      try { await api(`/api/admin/judges/${encodeURIComponent(name)}`, { method: 'DELETE' }); await refreshMeta(); toast('削除しました', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    };
    row.append(del);
    box.appendChild(row);
  }
}

// --- 設定 -----------------------------------------------------------
function fillSettingsForm() {
  const s = cache.settings;
  $('#setTitle').value = s.title;
  $('#setJudgeCode').value = s.judgeCode || '';
  $('#scaleMin').value = s.scale.min;
  $('#scaleMax').value = s.scale.max;
  $('#scaleStep').value = s.scale.step;
  $('#bayesPrior').value = s.bayesianPrior;
  $('#trimRatio').value = s.trimRatio;
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
    $('#newPassword').value = '';
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
    renderJudges();
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
  if (!confirm('全ての投票データを削除します。よろしいですか？')) return;
  try { await api('/api/admin/votes', { method: 'DELETE' }); await loadResults(); toast('リセットしました', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
});

async function refreshMeta() {
  const data = await api('/api/admin/settings');
  cache = data;
  renderItems();
  renderCriteria();
  renderJudges();
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
