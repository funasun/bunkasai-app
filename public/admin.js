// 管理・結果画面。全APIはトークン認証必須。
const $ = (sel) => document.querySelector(sel);
let token = sessionStorage.getItem('adminToken') || null;
let cache = { settings: null, criteria: [], items: [], methods: [] };
let voterFilter = 'judge';
let categoryFilter = ''; // '' = 総合（すべての出し物）

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
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  $('#tabs').querySelectorAll('button[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.tab').forEach((t) => t.classList.add('hidden'));
  $(`#tab-${btn.dataset.tab}`).classList.remove('hidden');
  if (btn.dataset.tab === 'results') loadResults();
  if (btn.dataset.tab === 'survey-results') loadSurveyResults();
});

// --- 起動 -----------------------------------------------------------
async function boot() {
  showAdmin();
  const data = await api('/api/admin/settings');
  cache = data;
  fillSettingsForm();
  fillMethodSelect();
  renderMeta();
  await loadResults();
  await loadBackups();
}

// 出し物・部門・設問など、マスターデータに依存するUIをまとめて再描画
function renderMeta() {
  renderCategories();
  fillCategorySelects();
  renderItems();
  renderCriteria();
  renderQuestions();
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

// 部門フィルタ: 部門内の出し物だけに絞って順位を振り直す（スコアは全体計算のまま）
function applyCategoryFilter(rows) {
  if (!categoryFilter) return rows;
  const inCat = new Set(cache.items.filter((i) => i.categoryId === categoryFilter).map((i) => i.id));
  const filtered = rows.filter((r) => inCat.has(r.itemId));
  let rank = 0;
  let prevScore = null;
  filtered.forEach((row, i) => {
    if (prevScore === null || row.score !== prevScore) { rank = i + 1; prevScore = row.score; }
    row = filtered[i] = { ...row, rank };
  });
  return filtered;
}

function categoryLabel() {
  if (!categoryFilter) return '総合';
  return cache.categories.find((c) => c.id === categoryFilter)?.name || '総合';
}

function renderRanking() {
  const rows = applyCategoryFilter(resultsData[voterFilter].current);
  $('#rankingTitle').textContent = categoryFilter ? `順位（${categoryLabel()}）` : '順位（総合）';
  if (!rows.length) {
    $('#rankingTable').innerHTML = '<div class="empty">この部門にはまだ出し物がありません。</div>';
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

// --- 順位の画像出力（公表用） ------------------------------------------
$('#exportRankingImg').addEventListener('click', () => {
  const rows = applyCategoryFilter(resultsData?.[voterFilter]?.current || []);
  if (!rows.length) return toast('出力できる順位がありません', 'err');
  const canvas = drawRankingImage(rows);
  showImagePreview(canvas, `順位_${categoryLabel()}_${voterFilter === 'judge' ? '採点委員' : '来場者'}.png`);
});

// --- 画像保存前のプレビュー -------------------------------------------
let modalCanvas = null;
let modalFilename = '';

function showImagePreview(canvas, filename) {
  modalCanvas = canvas;
  modalFilename = filename;
  const body = $('#imgModalBody');
  body.innerHTML = '';
  body.appendChild(canvas);
  $('#imgModal').classList.remove('hidden');
}
function closeImageModal() {
  $('#imgModal').classList.add('hidden');
  $('#imgModalBody').innerHTML = '';
  modalCanvas = null;
}
$('#imgModalClose').addEventListener('click', closeImageModal);
$('#imgModal').addEventListener('click', (e) => { if (e.target === $('#imgModal')) closeImageModal(); });
$('#imgModalSave').addEventListener('click', () => {
  if (!modalCanvas) return;
  downloadCanvas(modalCanvas, modalFilename);
  toast('画像を保存しました', 'ok');
  closeImageModal();
});

function drawRankingImage(rows) {
  const scale = 2;
  const width = 900;
  const rowH = 52;
  const padTop = 120;
  const padBottom = 46;
  const height = padTop + rows.length * rowH + padBottom;
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#4f46e5';
  ctx.fillRect(0, 0, width, 6);

  const voterLabel = voterFilter === 'judge' ? '採点委員' : '来場者';
  const methodName = isChoiceVisitor()
    ? '得票数'
    : (cache.methods.find((m) => m.id === resultsData.method)?.name || '');
  ctx.fillStyle = '#16203a';
  ctx.font = 'bold 26px sans-serif';
  ctx.fillText(`${cache.settings.title || '文化祭 採点'}　結果発表`, 32, 52);
  ctx.fillStyle = '#64748b';
  ctx.font = '15px sans-serif';
  ctx.fillText(`${categoryLabel()}順位 ／ ${voterLabel}の投票 ／ 集計: ${methodName}`, 32, 82);

  const scoreLabel = isChoiceVisitor() ? '得票数' : 'スコア';
  const scores = rows.map((r) => r.score);
  const maxS = Math.max(...scores);
  const minS = Math.min(...scores, 0);
  const span = maxS - minS || 1;
  const nameX = 100;
  const barX = 480;
  const barMaxW = width - barX - 140;
  const medal = { 1: '#f5b301', 2: '#9aa5b1', 3: '#c9781e' };

  ctx.font = '13px sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.fillText(scoreLabel, barX, padTop - 12);

  rows.forEach((r, i) => {
    const y = padTop + i * rowH;
    if (i % 2 === 0) {
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(20, y, width - 40, rowH - 6);
    }
    // 順位バッジ
    ctx.beginPath();
    ctx.arc(56, y + 23, 17, 0, Math.PI * 2);
    ctx.fillStyle = medal[r.rank] || '#e2e8f0';
    ctx.fill();
    ctx.fillStyle = medal[r.rank] ? '#ffffff' : '#16203a';
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(r.rank), 56, y + 28);
    ctx.textAlign = 'left';
    // 出し物名
    ctx.fillStyle = '#16203a';
    ctx.font = 'bold 16px sans-serif';
    let name = r.name;
    while (ctx.measureText(name).width > barX - nameX - 20 && name.length > 1) name = name.slice(0, -1);
    if (name !== r.name) name += '…';
    ctx.fillText(name, nameX, y + 28);
    // スコアバー＋数値
    const w = Math.max(4, ((r.score - minS) / span) * barMaxW);
    ctx.fillStyle = '#eef2ff';
    ctx.fillRect(barX, y + 12, barMaxW, 20);
    ctx.fillStyle = '#4f46e5';
    ctx.fillRect(barX, y + 12, w, 20);
    ctx.fillStyle = '#16203a';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(String(r.score), barX + barMaxW + 10, y + 27);
  });

  ctx.fillStyle = '#94a3b8';
  ctx.font = '12px sans-serif';
  ctx.fillText(`出力日時: ${new Date().toLocaleString('ja-JP')}`, 32, height - 18);
  return canvas;
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
    rankMaps[m.id] = new Map(applyCategoryFilter(group.byMethod[m.id]).map((r) => [r.itemId, r.rank]));
  }
  let html = '<table><thead><tr><th class="sticky-col">出し物</th>';
  for (const m of cache.methods) {
    const active = m.id === cache.settings.method;
    html += `<th class="num"${active ? ' style="color:var(--primary)"' : ''}>${m.name}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (const r of applyCategoryFilter(group.current)) {
    html += `<tr><td class="sticky-col"><strong>${escapeHtml(r.name)}</strong></td>`;
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

// --- 部門 -----------------------------------------------------------
let editingCatId = null;

function resetCatForm() {
  editingCatId = null;
  $('#catName').value = '';
  $('#addCat').textContent = '部門を追加';
  $('#cancelEditCat').classList.add('hidden');
}
$('#cancelEditCat').addEventListener('click', resetCatForm);

$('#addCat').addEventListener('click', async () => {
  const name = $('#catName').value.trim();
  if (!name) return toast('部門名を入力してください', 'err');
  try {
    if (editingCatId) {
      await api(`/api/admin/categories/${editingCatId}`, { method: 'PUT', body: JSON.stringify({ name }) });
      toast('部門名を変更しました', 'ok');
    } else {
      await api('/api/admin/categories', { method: 'POST', body: JSON.stringify({ name }) });
      toast('部門を追加しました', 'ok');
    }
    resetCatForm();
    await refreshMeta();
  } catch (e) { toast(e.message, 'err'); }
});

function renderCategories() {
  const box = $('#catList');
  const cats = cache.categories || [];
  if (!cats.length) { box.innerHTML = '<div class="empty">まだ部門はありません（なくても使えます）。</div>'; return; }
  box.innerHTML = '';
  for (const cat of cats) {
    const count = cache.items.filter((i) => i.categoryId === cat.id).length;
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `<div class="grow"><strong>${escapeHtml(cat.name)}</strong> <span class="muted">${count}件の出し物</span></div>`;
    const edit = document.createElement('button');
    edit.className = 'ghost'; edit.textContent = '名前変更';
    edit.onclick = () => {
      editingCatId = cat.id;
      $('#catName').value = cat.name;
      $('#addCat').textContent = '名前を更新';
      $('#cancelEditCat').classList.remove('hidden');
      $('#catName').focus();
    };
    const del = document.createElement('button');
    del.className = 'danger'; del.textContent = '削除';
    del.onclick = async () => {
      if (!confirm(`部門「${cat.name}」を削除しますか？\n所属していた出し物は「部門なし」になります（票は消えません）。`)) return;
      try {
        await api(`/api/admin/categories/${cat.id}`, { method: 'DELETE' });
        if (editingCatId === cat.id) resetCatForm();
        await refreshMeta();
        toast('削除しました', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
    row.append(edit, del);
    box.appendChild(row);
  }
}

// 出し物追加フォームと結果の部門フィルタのセレクトを部門一覧で更新
function fillCategorySelects() {
  const cats = cache.categories || [];
  $('#itemCat').innerHTML = '<option value="">部門なし</option>' +
    cats.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  $('#categoryFilterWrap').classList.toggle('hidden', !cats.length);
  $('#categoryFilter').innerHTML = '<option value="">総合（すべての出し物）</option>' +
    cats.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  if (![...$('#categoryFilter').options].some((o) => o.value === categoryFilter)) categoryFilter = '';
  $('#categoryFilter').value = categoryFilter;
}

$('#categoryFilter').addEventListener('change', () => {
  categoryFilter = $('#categoryFilter').value;
  renderRanking();
  renderCompare();
  renderJudgeMatrix();
});

// --- 出し物 ---------------------------------------------------------
let editingItemId = null;

function resetItemForm() {
  editingItemId = null;
  $('#itemName').value = '';
  $('#itemDesc').value = '';
  $('#itemCat').value = '';
  $('#itemFormTitle').textContent = '出し物を追加';
  $('#addItem').textContent = '追加';
  $('#cancelEditItem').classList.add('hidden');
}
$('#cancelEditItem').addEventListener('click', resetItemForm);

$('#addItem').addEventListener('click', async () => {
  const name = $('#itemName').value.trim();
  if (!name) return toast('名前を入力してください', 'err');
  const body = JSON.stringify({ name, description: $('#itemDesc').value, categoryId: $('#itemCat').value });
  try {
    if (editingItemId) {
      await api(`/api/admin/items/${editingItemId}`, { method: 'PUT', body });
      toast('出し物を更新しました', 'ok');
    } else {
      await api('/api/admin/items', { method: 'POST', body });
      toast('追加しました', 'ok');
    }
    resetItemForm();
    await refreshMeta();
  } catch (e) { toast(e.message, 'err'); }
});

function renderItems() {
  const box = $('#itemsList');
  $('#itemsListTitle').textContent = `登録済みの出し物（${cache.items.length}件）`;
  if (!cache.items.length) {
    box.innerHTML = '<div class="empty">まだ出し物がありません。上のフォームから追加してください。</div>';
    return;
  }
  box.innerHTML = '';
  const cats = cache.categories || [];
  const groups = cats.length ? [...cats, { id: '', name: '部門なし' }] : [{ id: '', name: '' }];
  for (const g of groups) {
    const items = cats.length
      ? cache.items.filter((i) => (i.categoryId || '') === g.id)
      : cache.items;
    if (!items.length) continue;
    if (cats.length) {
      const h = document.createElement('div');
      h.className = 'cat-heading';
      h.textContent = `${g.name}（${items.length}件）`;
      box.appendChild(h);
    }
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'list-row';
      row.innerHTML = `<div class="grow"><strong>${escapeHtml(item.name)}</strong>` +
        (item.description ? ` <span class="muted">${escapeHtml(item.description)}</span>` : '') + '</div>';
      if (cats.length) {
        const sel = document.createElement('select');
        sel.style.cssText = 'width:auto;max-width:180px;padding:8px 10px';
        sel.title = '部門を変更';
        sel.innerHTML = '<option value="">部門なし</option>' +
          cats.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
        sel.value = item.categoryId || '';
        sel.onchange = async () => {
          try {
            await api(`/api/admin/items/${item.id}`, { method: 'PUT', body: JSON.stringify({ categoryId: sel.value }) });
            item.categoryId = sel.value;
            renderCategories();
            renderItems();
            toast('部門を変更しました', 'ok');
          } catch (e) { toast(e.message, 'err'); }
        };
        row.append(sel);
      }
      const edit = document.createElement('button');
      edit.className = 'ghost'; edit.textContent = '編集';
      edit.onclick = () => {
        editingItemId = item.id;
        $('#itemName').value = item.name;
        $('#itemDesc').value = item.description || '';
        $('#itemCat').value = item.categoryId || '';
        $('#itemFormTitle').textContent = `出し物を編集中: ${item.name}`;
        $('#addItem').textContent = 'この内容で更新';
        $('#cancelEditItem').classList.remove('hidden');
        $('#itemFormTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      const del = document.createElement('button');
      del.className = 'danger'; del.textContent = '削除';
      del.onclick = async () => {
        if (!confirm(`「${item.name}」を削除しますか？この出し物への投票も消えます。`)) return;
        try {
          await api(`/api/admin/items/${item.id}`, { method: 'DELETE' });
          if (editingItemId === item.id) resetItemForm();
          await refreshMeta();
          toast('削除しました', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
      row.append(edit, del);
      box.appendChild(row);
    }
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

const WEIGHT_LABELS = { 0.5: '参考程度', 1: '標準', 1.5: 'やや重視', 2: '重視', 3: '最重視' };

function renderCriteria() {
  const box = $('#critList');
  box.innerHTML = '';
  for (const c of cache.criteria) {
    const row = document.createElement('div');
    row.className = 'list-row';
    const wLabel = WEIGHT_LABELS[c.weight] ? `${WEIGHT_LABELS[c.weight]}・重み ${c.weight}` : `重み ${c.weight}`;
    row.innerHTML = `<div class="grow"><strong>${escapeHtml(c.name)}</strong> <span class="tag">${wLabel}</span></div>`;
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

// --- アンケート設問（Googleフォーム風の編集） -------------------------
let editingQuestionId = null;

$('#qType').addEventListener('change', () => {
  $('#qOptionsWrap').classList.toggle('hidden', $('#qType').value !== 'choice');
});

$('#qMultiple').addEventListener('change', () => {
  [...$('#qOptionRows').children].forEach((r) => r.classList.toggle('multi', $('#qMultiple').checked));
});

$('#addOptionBtn').addEventListener('click', () => addOptionRow('', true));
$('#cancelEditQ').addEventListener('click', resetQuestionForm);

function addOptionRow(value = '', focus = false) {
  const row = document.createElement('div');
  row.className = 'option-row' + ($('#qMultiple').checked ? ' multi' : '');
  const dot = document.createElement('span');
  dot.className = 'opt-dot';
  const input = document.createElement('input');
  input.value = value;
  // Enterで次の選択肢を追加（Googleフォームと同じ操作感）
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addOptionRow('', true); }
  });
  const rm = document.createElement('button');
  rm.type = 'button'; rm.className = 'opt-remove'; rm.textContent = '✕';
  rm.title = 'この選択肢を削除';
  rm.onclick = () => {
    if ($('#qOptionRows').children.length <= 2) return toast('選択肢は2つ以上必要です', 'err');
    row.remove();
    renumberOptionRows();
  };
  row.append(dot, input, rm);
  $('#qOptionRows').appendChild(row);
  renumberOptionRows();
  if (focus) input.focus();
}

function renumberOptionRows() {
  [...$('#qOptionRows').querySelectorAll('input')].forEach((inp, i) => { inp.placeholder = `選択肢 ${i + 1}`; });
}

function getOptionValues() {
  return [...$('#qOptionRows').querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
}

function resetQuestionForm() {
  editingQuestionId = null;
  $('#qText').value = '';
  $('#qType').value = 'choice';
  $('#qMultiple').checked = false;
  $('#qOptionsWrap').classList.remove('hidden');
  $('#qOptionRows').innerHTML = '';
  addOptionRow();
  addOptionRow();
  $('#qFormTitle').textContent = '設問を追加';
  $('#addQuestion').textContent = '設問を追加';
  $('#cancelEditQ').classList.add('hidden');
}
resetQuestionForm();

$('#addQuestion').addEventListener('click', async () => {
  const question = $('#qText').value.trim();
  if (!question) return toast('質問文を入力してください', 'err');
  const type = $('#qType').value;
  const options = type === 'choice' ? getOptionValues() : [];
  if (type === 'choice' && options.length < 2) return toast('選択肢は2つ以上入力してください', 'err');
  const body = JSON.stringify({ question, type, options, multiple: $('#qMultiple').checked });
  try {
    if (editingQuestionId) {
      await api(`/api/admin/survey-questions/${editingQuestionId}`, { method: 'PUT', body });
      toast('設問を更新しました', 'ok');
    } else {
      await api('/api/admin/survey-questions', { method: 'POST', body });
      toast('設問を追加しました', 'ok');
    }
    resetQuestionForm();
    await refreshMeta();
  } catch (e) { toast(e.message, 'err'); }
});

function renderQuestions() {
  const box = $('#questionList');
  box.innerHTML = '';
  const questions = cache.surveyQuestions || [];
  if (!questions.length) {
    box.innerHTML = '<div class="empty">設問はまだありません。設問を追加すると、来場者の画面にアンケートが表示されます。</div>';
    return;
  }
  questions.forEach((q, idx) => {
    const row = document.createElement('div');
    row.className = 'list-row';
    const typeLabel = q.type === 'text' ? '記述式' : q.multiple ? '選択式・複数可' : '選択式';
    const detail = q.type === 'choice' ? `<span class="muted">${q.options.map(escapeHtml).join(' ／ ')}</span>` : '';
    row.innerHTML = `<div class="grow"><strong>Q${idx + 1}. ${escapeHtml(q.question)}</strong> <span class="tag">${typeLabel}</span><br>${detail}</div>`;
    const edit = document.createElement('button');
    edit.className = 'secondary'; edit.textContent = '編集';
    edit.onclick = () => {
      editingQuestionId = q.id;
      $('#qText').value = q.question;
      $('#qType').value = q.type;
      $('#qOptionsWrap').classList.toggle('hidden', q.type !== 'choice');
      $('#qMultiple').checked = q.multiple === true;
      $('#qOptionRows').innerHTML = '';
      if (q.type === 'choice') q.options.forEach((o) => addOptionRow(o));
      else { addOptionRow(); addOptionRow(); }
      $('#qFormTitle').textContent = `設問を編集中（Q${idx + 1}）`;
      $('#addQuestion').textContent = 'この内容で更新';
      $('#cancelEditQ').classList.remove('hidden');
      $('#qFormTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    const del = document.createElement('button');
    del.className = 'danger'; del.textContent = '削除';
    del.onclick = async () => {
      if (!confirm(`設問「${q.question}」を削除しますか？`)) return;
      try {
        await api(`/api/admin/survey-questions/${q.id}`, { method: 'DELETE' });
        if (editingQuestionId === q.id) resetQuestionForm();
        await refreshMeta();
        toast('削除しました', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
    row.append(edit, del);
    box.appendChild(row);
  });
}

// --- アンケート結果 ---------------------------------------------------
$('#reloadSurveyBtn').addEventListener('click', loadSurveyResults);

$('#resetSurveyBtn').addEventListener('click', async () => {
  if (!confirm('アンケートの回答をすべて削除します。よろしいですか？')) return;
  try {
    await api('/api/admin/survey', { method: 'DELETE' });
    await loadSurveyResults();
    toast('回答をリセットしました', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

async function loadSurveyResults() {
  const box = $('#surveyResults');
  try {
    const data = await api('/api/admin/survey');
    $('#surveyTotal').textContent = data.total
      ? `回答者 ${data.total}名（1人1回答・再送信で上書き）`
      : 'まだ回答がありません。';
    box.innerHTML = '';
    data.questions.forEach((q, idx) => {
      const block = document.createElement('div');
      block.style.cssText = 'margin-top:18px;padding-top:14px;border-top:1px solid var(--line)';
      const title = document.createElement('h3');
      title.style.cssText = 'margin:0 0 10px;font-size:1.02rem';
      title.textContent = `Q${idx + 1}. ${q.question}`;
      block.appendChild(title);

      if (q.type === 'choice') {
        const canvas = drawSurveyChart(q);
        canvas.style.cssText = 'width:100%;max-width:720px;height:auto;display:block';
        block.appendChild(canvas);
        const note = document.createElement('p');
        note.className = 'muted';
        note.style.cssText = 'margin:6px 0 8px;font-size:.85rem';
        note.textContent = `回答 ${q.answered}名${q.multiple ? '（複数選択可）' : ''}`;
        block.appendChild(note);
        const save = document.createElement('button');
        save.className = 'secondary'; save.textContent = '画像で保存';
        save.onclick = () => showImagePreview(drawSurveyChart(q), `アンケートQ${idx + 1}.png`);
        block.appendChild(save);
      } else {
        const answers = q.answers || [];
        if (!answers.length) {
          block.insertAdjacentHTML('beforeend', '<div class="empty">まだ回答がありません。</div>');
        } else {
          const list = document.createElement('div');
          list.style.cssText = 'max-height:340px;overflow-y:auto;border:1px solid var(--line);border-radius:10px';
          list.innerHTML = answers.map((a) =>
            `<div style="padding:10px 14px;border-bottom:1px solid var(--line);white-space:pre-wrap">${escapeHtml(a)}</div>`
          ).join('');
          block.appendChild(list);
          const note = document.createElement('p');
          note.className = 'muted';
          note.style.cssText = 'margin:6px 0 0;font-size:.85rem';
          note.textContent = `回答 ${answers.length}件`;
          block.appendChild(note);
        }
      }
      box.appendChild(block);
    });
    if (!data.questions.length) box.innerHTML = '<div class="empty">設問がありません。「来場者アンケート」タブから追加してください。</div>';
  } catch (e) { toast(e.message, 'err'); }
}

// 選択式の集計を横棒グラフとして描画（2倍解像度でくっきり保存できる）
function drawSurveyChart(q) {
  const scale = 2;
  const width = 720;
  const rowH = 46;
  const padTop = 52;
  const padBottom = 16;
  const height = padTop + q.options.length * rowH + padBottom;
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#16203a';
  ctx.font = 'bold 15px sans-serif';
  ctx.fillText(q.question, 20, 28);

  const max = Math.max(...q.counts, 1);
  const labelW = 170;
  const barX = 20 + labelW + 10;
  const barMaxW = width - barX - 70;
  q.options.forEach((opt, i) => {
    const y = padTop + i * rowH;
    ctx.fillStyle = '#16203a';
    ctx.font = '13px sans-serif';
    let label = opt;
    while (ctx.measureText(label).width > labelW && label.length > 1) label = label.slice(0, -1);
    if (label !== opt) label += '…';
    ctx.fillText(label, 20, y + 22);
    ctx.fillStyle = '#eef2ff';
    ctx.fillRect(barX, y + 8, barMaxW, 22);
    ctx.fillStyle = '#4f46e5';
    ctx.fillRect(barX, y + 8, barMaxW * (q.counts[i] / max), 22);
    ctx.fillStyle = '#16203a';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText(`${q.counts[i]}票`, barX + barMaxW + 8, y + 24);
  });
  return canvas;
}

function downloadCanvas(canvas, filename) {
  canvas.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
}

// --- 審査員×出し物の採点表 -------------------------------------------
let judgeSelectValue = '';

$('#judgeSelect').addEventListener('change', () => {
  judgeSelectValue = $('#judgeSelect').value;
  renderJudgeMatrix();
});

function matrixItems() {
  if (!categoryFilter) return cache.items;
  return cache.items.filter((i) => i.categoryId === categoryFilter);
}

function renderJudgeMatrix() {
  const box = $('#judgeMatrix');
  const names = resultsData.judgeNames || [];
  const sel = $('#judgeSelect');
  sel.innerHTML = `<option value="">全員の一覧表（${names.length}名）</option>` +
    names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)} さんの採点だけ表示</option>`).join('');
  if (!names.includes(judgeSelectValue)) judgeSelectValue = '';
  sel.value = judgeSelectValue;

  const items = matrixItems();
  if (!names.length || !items.length) {
    box.innerHTML = '<div class="empty">まだ採点委員の採点がありません。</div>';
    return;
  }
  const critNames = cache.criteria.map((c) => c.name).join(' / ');

  // 1人分の表示: 出し物×採点項目の表（人数が多いときに見やすい）
  if (judgeSelectValue) {
    $('#judgeMatrixLead').textContent = `${judgeSelectValue} さんの採点です。太字が総合点（重み付き合計）。`;
    let html = '<table><thead><tr><th class="sticky-col">出し物</th><th class="num">総合点</th>';
    for (const c of cache.criteria) html += `<th class="num">${escapeHtml(c.name)}</th>`;
    html += '</tr></thead><tbody>';
    let scored = 0;
    for (const item of items) {
      const cell = resultsData.judgeTable?.[judgeSelectValue]?.[item.id];
      html += `<tr><td class="sticky-col"><strong>${escapeHtml(item.name)}</strong></td>`;
      if (!cell) {
        html += `<td class="num" style="color:var(--muted)">-</td>` +
          cache.criteria.map(() => '<td class="num" style="color:var(--muted)">-</td>').join('');
      } else {
        scored++;
        html += `<td class="num"><strong>${cell.total}</strong></td>` +
          cache.criteria.map((c) => `<td class="num">${cell.scores?.[c.id] ?? '-'}</td>`).join('');
      }
      html += '</tr>';
    }
    html += `</tbody></table><p class="muted" style="margin:10px 0 0">${scored} / ${items.length} 件を採点済み</p>`;
    box.innerHTML = html;
    return;
  }

  // 全員の一覧表: 先頭列固定＋横スクロール
  $('#judgeMatrixLead').textContent =
    `太字が総合点（重み付き合計）、カッコ内は項目別の点数（${critNames}）。人数が多いときは上のプルダウンで1人ずつ表示できます。表は横にスクロールできます。`;
  let html = '<table><thead><tr><th class="sticky-col">出し物</th>';
  for (const n of names) html += `<th class="num" style="white-space:nowrap">${escapeHtml(n)}</th>`;
  html += '</tr></thead><tbody>';
  for (const item of items) {
    html += `<tr><td class="sticky-col" style="white-space:nowrap"><strong>${escapeHtml(item.name)}</strong></td>`;
    for (const n of names) {
      const cell = resultsData.judgeTable?.[n]?.[item.id];
      if (!cell) {
        html += '<td class="num" style="color:var(--muted)">-</td>';
      } else {
        const detail = cache.criteria.map((c) => cell.scores?.[c.id] ?? '-').join(' / ');
        html += `<td class="num"><strong>${cell.total}</strong><br><span class="muted" style="font-size:.78rem;white-space:nowrap">(${detail})</span></td>`;
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
  renderMeta();
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
