// 投票端末用スクリプト。結果は一切取得・表示しない。
const state = {
  config: null,
  voterType: null,
  voterId: null,
  judgeCode: null,
  votedItems: new Set(),
  currentItem: null,
};

const $ = (sel) => document.querySelector(sel);

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  setTimeout(() => { t.className = 'toast'; }, 2200);
}

// 来場者はこの端末に紐づく匿名IDを発行（偏り補正のため同一人物の票をまとめる）
function getVisitorId() {
  let id = localStorage.getItem('visitorId');
  if (!id) {
    id = 'visitor_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('visitorId', id);
  }
  return id;
}

async function loadConfig() {
  const res = await fetch('/api/config');
  state.config = await res.json();
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
}

function show(cardId) {
  ['setupCard', 'listCard', 'voteCard'].forEach((id) => {
    const el = document.getElementById(id);
    el.classList.toggle('hidden', id !== cardId);
    if (id === cardId) {
      el.style.animation = 'none';
      void el.offsetWidth; // アニメーションを再生し直す
      el.style.animation = '';
    }
  });
  $('#actionBar').classList.toggle('hidden', cardId !== 'voteCard');
  window.scrollTo({ top: 0 });
}

// --- 区分の選択 -----------------------------------------------------
$('#voterTypeSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('.choice');
  if (!btn) return;
  state.voterType = btn.dataset.type;
  document.querySelectorAll('#voterTypeSeg .choice').forEach((b) => b.classList.toggle('active', b === btn));
  $('#judgeNameWrap').classList.toggle('hidden', state.voterType !== 'judge');
  if (state.voterType === 'judge') $('#judgeName').focus();
  validateStart();
});

$('#judgeName').addEventListener('input', validateStart);
$('#judgeCode').addEventListener('input', validateStart);
$('#judgeCode').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('#startBtn').disabled) $('#startBtn').click();
});

function validateStart() {
  let ok = !!state.voterType;
  if (state.voterType === 'judge' && (!$('#judgeName').value.trim() || !$('#judgeCode').value.trim())) ok = false;
  $('#startBtn').disabled = !ok;
}

$('#startBtn').addEventListener('click', async () => {
  if (state.voterType === 'judge') {
    // なりすまし防止: 採点開始前に登録名とコードを検証
    const code = $('#judgeCode').value.trim();
    const res = await fetch('/api/judge-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name: $('#judgeName').value.trim() }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return toast(data.error || '審査員コードが違います', 'err');
    }
    state.judgeCode = code;
    state.voterId = 'judge:' + $('#judgeName').value.trim();
  } else {
    state.judgeCode = null;
    state.voterId = getVisitorId();
  }
  $('#voterBadge').textContent = state.voterType === 'judge'
    ? `審査員 · ${$('#judgeName').value.trim()}`
    : '来場者';
  renderItemList();
  show('listCard');
});

$('#changeVoterBtn').addEventListener('click', () => show('setupCard'));

// --- 出し物一覧 -----------------------------------------------------
const checkSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
const arrowSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';

function renderItemList() {
  const list = $('#itemList');
  list.innerHTML = '';
  const items = state.config.items;
  const done = items.filter((i) => state.votedItems.has(i.id)).length;
  $('#progressLabel').textContent = `${done} / ${items.length}`;
  $('#progressFill').style.width = items.length ? `${(done / items.length) * 100}%` : '0%';

  if (!items.length) {
    list.innerHTML = '<div class="empty" style="grid-column:1/-1">まだ出し物が登録されていません。<br>管理画面から追加してください。</div>';
    return;
  }
  for (const item of items) {
    const voted = state.votedItems.has(item.id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item-card' + (voted ? ' voted' : '');
    btn.innerHTML =
      `<span class="i-name">${escapeHtml(item.name)}</span>` +
      (item.description ? `<span class="i-desc">${escapeHtml(item.description)}</span>` : '') +
      `<span class="i-status">${voted ? checkSvg + ' 採点済み · タップで修正' : '未採点'}</span>` +
      `<span class="i-arrow">${arrowSvg}</span>`;
    btn.addEventListener('click', () => openVote(item));
    list.appendChild(btn);
  }
}

// --- 採点フォーム ---------------------------------------------------
function openVote(item) {
  state.currentItem = item;
  $('#voteItemName').textContent = item.name;
  $('#voteItemDesc').textContent = item.description || '';
  const form = $('#criteriaForm');
  form.innerHTML = '';
  const { min, max, step } = state.config.scale;
  for (const c of state.config.criteria) {
    const block = document.createElement('div');
    block.className = 'criteria-block';
    block.innerHTML = `<div class="criteria-name">${escapeHtml(c.name)}</div>`;
    const scale = document.createElement('div');
    scale.className = 'score-scale';
    scale.dataset.criteria = c.id;
    for (let v = min; v <= max + 1e-9; v = +(v + step).toFixed(4)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = +v.toFixed(2);
      b.dataset.value = v;
      b.addEventListener('click', () => {
        [...scale.children].forEach((x) => x.classList.toggle('active', x === b));
        updateVoteStatus();
      });
      scale.appendChild(b);
    }
    block.appendChild(scale);
    const hint = document.createElement('div');
    hint.className = 'score-hint';
    hint.innerHTML = `<span>低い ${min}</span><span>${max} 高い</span>`;
    block.appendChild(hint);
    form.appendChild(block);
  }
  updateVoteStatus();
  show('voteCard');
}

function selectedScores() {
  const scores = {};
  document.querySelectorAll('#criteriaForm .score-scale').forEach((scale) => {
    const active = scale.querySelector('button.active');
    if (active) scores[scale.dataset.criteria] = Number(active.dataset.value);
  });
  return scores;
}

function updateVoteStatus() {
  const total = state.config.criteria.length;
  const done = Object.keys(selectedScores()).length;
  $('#voteStatus').textContent = `${done} / ${total} 項目を選択中`;
  $('#submitVote').disabled = done === 0;
}

$('#backBtn').addEventListener('click', () => show('listCard'));

$('#submitVote').addEventListener('click', async () => {
  const scores = selectedScores();
  if (Object.keys(scores).length === 0) {
    return toast('少なくとも1項目は選んでください', 'err');
  }
  try {
    const res = await fetch('/api/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voterType: state.voterType,
        voterId: state.voterId,
        judgeCode: state.judgeCode,
        itemId: state.currentItem.id,
        scores,
      }),
    });
    const data = await res.json();
    if (!res.ok) return toast(data.error || '投票に失敗しました', 'err');
    state.votedItems.add(state.currentItem.id);
    toast(`「${state.currentItem.name}」に投票しました`, 'ok');
    renderItemList();
    show('listCard');
  } catch {
    toast('通信エラー。もう一度お試しください', 'err');
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

loadConfig();
