// 投票端末用スクリプト。結果は一切取得・表示しない。
const state = {
  config: null,
  voterType: null,
  voterId: null,
  judgeCode: null,
  votedItems: new Set(),
  choices: new Set(),   // 選択方式で選んだ出し物
  choiceMode: false,    // 来場者×選択方式のときtrue
  surveyAnswers: null,  // 最後に送信したアンケート回答（書き直し用）
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
  const open = state.config.votingOpen !== false;
  $('#closedNotice').classList.toggle('hidden', open);
  $('#startArea').classList.toggle('hidden', !open);
}

function show(cardId) {
  ['setupCard', 'listCard', 'voteCard', 'surveyCard'].forEach((id) => {
    const el = document.getElementById(id);
    el.classList.toggle('hidden', id !== cardId);
    if (id === cardId) {
      el.style.animation = 'none';
      void el.offsetWidth; // アニメーションを再生し直す
      el.style.animation = '';
    }
  });
  const barVisible = cardId === 'voteCard' || (cardId === 'listCard' && state.choiceMode);
  $('#actionBar').classList.toggle('hidden', !barVisible);
  window.scrollTo({ top: 0 });
}

// --- 区分の選択 -----------------------------------------------------
function startAs(voterType, voterId, badge) {
  if (state.voterId !== voterId) { state.votedItems.clear(); state.choices.clear(); }
  state.voterType = voterType;
  state.voterId = voterId;
  state.choiceMode = voterType === 'visitor' && state.config.visitorVoteMode === 'choice';
  $('#voterBadge').textContent = badge;
  renderItemList();
  show('listCard');
}

// メイン導線: 来場者はワンタップで開始
$('#visitorStartBtn').addEventListener('click', () => {
  state.judgeCode = null;
  startAs('visitor', getVisitorId(), '来場者');
});

// 審査員は折りたたみの中から開始（一般のかたが誤って選ばないように）
$('#judgeToggle').addEventListener('click', () => {
  const wrap = $('#judgeNameWrap');
  wrap.classList.toggle('hidden');
  if (!wrap.classList.contains('hidden')) $('#judgeName').focus();
});

$('#judgeName').addEventListener('input', validateStart);
$('#judgeCode').addEventListener('input', validateStart);
$('#judgeCode').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('#startBtn').disabled) $('#startBtn').click();
});

function validateStart() {
  $('#startBtn').disabled = !($('#judgeName').value.trim() && $('#judgeCode').value.trim());
}

$('#startBtn').addEventListener('click', async () => {
  // なりすまし防止: 採点開始前に名前とコードを検証
  const code = $('#judgeCode').value.trim();
  const name = $('#judgeName').value.trim();
  const res = await fetch('/api/judge-verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return toast(data.error || '採点委員コードが違います', 'err');
  }
  state.judgeCode = code;
  startAs('judge', 'judge:' + name, `採点委員 · ${name}`);
});

$('#changeVoterBtn').addEventListener('click', () => show('setupCard'));

// --- 出し物一覧 -----------------------------------------------------
const checkSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
const arrowSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';

function renderItemList() {
  const list = $('#itemList');
  list.innerHTML = '';
  const items = state.config.items;
  const max = Math.max(1, state.config.choiceMax || 1);

  if (state.choiceMode) {
    $('#listTitle').textContent = 'お気に入りの出し物を選ぼう';
    $('#listLead').textContent = max === 1
      ? 'いちばん気に入った出し物を1つ選んで投票してください。あとから選び直すこともできます。'
      : `気に入った出し物を最大${max}つまで選んで投票してください。あとから選び直すこともできます。`;
    $('#progressLabel').textContent = `${state.choices.size} / ${max}`;
    $('#progressFill').style.width = `${(state.choices.size / max) * 100}%`;
  } else {
    $('#listTitle').textContent = '出し物を選んで採点';
    $('#listLead').textContent = '採点済みの出し物はあとから何度でも修正できます。';
    const done = items.filter((i) => state.votedItems.has(i.id)).length;
    $('#progressLabel').textContent = `${done} / ${items.length}`;
    $('#progressFill').style.width = items.length ? `${(done / items.length) * 100}%` : '0%';
  }

  if (!items.length) {
    list.innerHTML = '<div class="empty" style="grid-column:1/-1">まだ出し物が登録されていません。<br>管理画面から追加してください。</div>';
    return;
  }

  const appendItem = (item) => {
    const marked = state.choiceMode ? state.choices.has(item.id) : state.votedItems.has(item.id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item-card' + (marked ? ' voted' : '');
    const status = state.choiceMode
      ? (marked ? checkSvg + ' 選択中 · タップで解除' : 'タップで選択')
      : (marked ? checkSvg + ' 採点済み · タップで修正' : '未採点');
    btn.innerHTML =
      `<span class="i-name">${escapeHtml(item.name)}</span>` +
      (item.description ? `<span class="i-desc">${escapeHtml(item.description)}</span>` : '') +
      `<span class="i-status">${status}</span>` +
      `<span class="i-arrow">${state.choiceMode ? '' : arrowSvg}</span>`;
    btn.addEventListener('click', () => (state.choiceMode ? toggleChoice(item) : openVote(item)));
    list.appendChild(btn);
  };

  // 部門があれば部門ごとに見出しを付けて表示する
  const cats = state.config.categories || [];
  if (cats.length) {
    const groups = [...cats, { id: '', name: 'その他' }];
    for (const cat of groups) {
      const group = items.filter((i) => (i.categoryId || '') === cat.id);
      if (!group.length) continue;
      const heading = document.createElement('div');
      heading.className = 'cat-heading';
      heading.textContent = cat.name;
      list.appendChild(heading);
      group.forEach(appendItem);
    }
  } else {
    items.forEach(appendItem);
  }

  // 来場者にはアンケートの案内を表示（設問があるときだけ）
  const showSurvey = state.voterType === 'visitor' && (state.config.survey || []).length > 0;
  $('#surveyBanner').classList.toggle('hidden', !showSurvey);

  if (state.choiceMode) updateChoiceStatus();
}

// --- アンケート -------------------------------------------------------
$('#openSurveyBtn').addEventListener('click', () => { renderSurveyForm(); show('surveyCard'); });
$('#surveyBackBtn').addEventListener('click', () => show('listCard'));

function renderSurveyForm() {
  const form = $('#surveyForm');
  form.innerHTML = '';
  for (const q of state.config.survey || []) {
    const block = document.createElement('div');
    block.className = 'criteria-block';
    block.dataset.qid = q.id;
    block.dataset.qtype = q.type;
    const title = document.createElement('div');
    title.className = 'criteria-name';
    title.textContent = q.question + (q.type === 'choice' && q.multiple ? '（複数選択OK）' : '');
    block.appendChild(title);
    if (q.type === 'text') {
      const ta = document.createElement('textarea');
      ta.rows = 3;
      ta.maxLength = 2000;
      ta.placeholder = '自由にご記入ください（任意）';
      ta.style.cssText = 'width:100%;resize:vertical';
      ta.value = state.surveyAnswers?.[q.id] || '';
      block.appendChild(ta);
    } else {
      const scale = document.createElement('div');
      scale.className = 'score-scale';
      q.options.forEach((opt, idx) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = opt;
        b.dataset.idx = idx;
        b.style.minWidth = 'auto';
        b.style.padding = '10px 14px';
        const prev = state.surveyAnswers?.[q.id];
        if (Array.isArray(prev) ? prev.includes(idx) : prev === idx) b.classList.add('active');
        b.addEventListener('click', () => {
          if (!q.multiple) [...scale.children].forEach((x) => { if (x !== b) x.classList.remove('active'); });
          b.classList.toggle('active');
        });
        scale.appendChild(b);
      });
      block.appendChild(scale);
    }
    form.appendChild(block);
  }
}

$('#submitSurvey').addEventListener('click', async () => {
  const answers = {};
  document.querySelectorAll('#surveyForm .criteria-block').forEach((block) => {
    const qid = block.dataset.qid;
    if (block.dataset.qtype === 'text') {
      const v = block.querySelector('textarea').value.trim();
      if (v) answers[qid] = v;
    } else {
      const idxs = [...block.querySelectorAll('.score-scale button.active')].map((b) => Number(b.dataset.idx));
      if (idxs.length) answers[qid] = idxs.length === 1 ? idxs[0] : idxs;
    }
  });
  if (Object.keys(answers).length === 0) {
    return toast('少なくとも1問は回答してください', 'err');
  }
  try {
    const res = await fetch('/api/survey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voterId: state.voterId || getVisitorId(), answers }),
    });
    const data = await res.json();
    if (!res.ok) return toast(data.error || '送信に失敗しました', 'err');
    state.surveyAnswers = answers;
    toast('アンケートを送信しました。ご協力ありがとうございます！', 'ok');
    show('listCard');
  } catch {
    toast('通信エラー。もう一度お試しください', 'err');
  }
});

// --- 選択方式（お気に入りを選ぶ） -------------------------------------
function toggleChoice(item) {
  const max = Math.max(1, state.config.choiceMax || 1);
  if (state.choices.has(item.id)) {
    state.choices.delete(item.id);
  } else if (state.choices.size >= max) {
    if (max === 1) {
      state.choices.clear();
      state.choices.add(item.id);
    } else {
      return toast(`選べるのは${max}つまでです。選択を外してから選び直してください`, 'err');
    }
  } else {
    state.choices.add(item.id);
  }
  renderItemList();
}

function updateChoiceStatus() {
  const max = Math.max(1, state.config.choiceMax || 1);
  const n = state.choices.size;
  $('#voteStatus').textContent = `${n} / ${max} 件を選択中`;
  $('#submitVote').disabled = n === 0;
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
  if (state.choiceMode) {
    if (state.choices.size === 0) return toast('少なくとも1つ選んでください', 'err');
    try {
      const res = await fetch('/api/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voterType: state.voterType,
          voterId: state.voterId,
          choices: [...state.choices],
        }),
      });
      const data = await res.json();
      if (!res.ok) return toast(data.error || '投票に失敗しました', 'err');
      toast(`${data.count}件に投票しました。あとから選び直すこともできます`, 'ok');
    } catch {
      toast('通信エラー。もう一度お試しください', 'err');
    }
    return;
  }
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
