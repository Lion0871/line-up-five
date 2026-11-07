'use strict';
/* Line-up Five — front-end client (vanilla, no framework, no login). */
const $ = s => document.querySelector(s);
const api = {
  async call(method, path, body, token) {
  const res = await fetch(path, {
      method,
      headers: Object.assign({ 'content-type': 'application/json' }, token ? { 'authorization': 'Bearer ' + token } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || res.status), { status: res.status });
    return json;
  },
};
const LET = { R: 'red', B: 'blue', G: 'green', Y: 'yellow' };
let cur = null;      // {code}
let tokens = {};     // seatIndex -> seatToken (for seats we hold)
let pollTimer = null;

/* ---------- lobby ---------- */
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  for (const p of ['create', 'join']) $('#pane-' + p).classList.toggle('hidden', p !== t.dataset.pane);
}));

$('#btn-create').addEventListener('click', async () => {
  const players = Number($('#players').value);
  const withBot = $('#bots').value === 'auto';
  const humans = withBot ? players - 1 : players;
  try {
    const g = await api.call('POST', '/api/games', { humans, size: 13, players });
    g.seats.forEach(s => tokens[s.seat] = s.seatToken);
    saveTokens();
    showCreated(g);
  } catch (e) { alert('创建失败：' + e.message); }
});

function showCreated(g) {
  const el = $('#created');
  const base = location.origin;
  let html = `加入码：<b>${g.code}</b>（把下面的分享链接或 token 发给朋友）<br>`;
  html += `<a href="/?join=${g.code}" class="hint">分享链接：?join=${g.code}</a>`;
  for (const s of g.seats) {
    html += `<div class="share"><b>座位${s.seat} ${s.color}</b>（${s.role}）` +
      (s.role === 'bot'
        ? ` — bot 席位，运行命令补位：<code>node bot/sample_bot.js --url ${base} --code ${g.code} --token ${s.seatToken}</code>`
        : ` token：<code>${s.seatToken}</code><br>玩家链接：<a href="/?join=${g.code}&seat=${s.seat}&token=${s.seatToken}">点此进入座位${s.seat}</a>`) +
      `</div>`;
  }
  el.innerHTML = html;
  enterGame(g.code);
}

$('#btn-join').addEventListener('click', async () => {
  const code = $('#join-code').value.trim().toUpperCase();
  const seat = Number($('#join-seat').value);
  const tok = $('#join-token').value.trim();
  try {
    await api.call('POST', `/api/games/${code}/join`, { seat, seatToken: tok });
    tokens[seat] = tok; saveTokens();
    enterGame(code);
  } catch (e) { alert('加入失败：' + e.message); }
});

function saveTokens() { if (cur) localStorage.setItem('luf:' + cur.code, JSON.stringify(tokens)); }
function loadTokens(code) { try { return JSON.parse(localStorage.getItem('luf:' + code) || '{}'); } catch { return {}; } }

/* ---------- game view ---------- */
function enterGame(code) {
  cur = { code };
  tokens = loadTokens(code);
  $('#lobby').classList.add('hidden');
  $('#game').classList.remove('hidden');
  $('#g-code').textContent = '加入码 ' + code;
  if (pollTimer) clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(poll, 1500);
}

$('#btn-lobby').addEventListener('click', () => {
  clearInterval(pollTimer); pollTimer = null;
  $('#game').classList.add('hidden'); $('#lobby').classList.remove('hidden');
});

async function poll() {
  if (!cur) return;
  let st;
  try { st = await api.call('GET', '/api/games/' + cur.code); } catch (e) { return; }
  render(st);
}

function render(st) {
  $('#g-move').textContent = `第 ${st.moveNo} 手 · ${st.players.filter(p => !p.resigned).length} 人在局`;
  const tb = $('#g-turn');
  tb.textContent = st.turn ? `轮到 ${st.turn}` : '已结束';
  tb.className = 'turnbadge ' + (st.turn || '');
  $('#g-status').textContent = st.status === 'playing' ? '' : st.status.toUpperCase();
  // board
  const b = $('#board');
  const winSet = new Set((st.winLine || []).map(c => c[0] + ',' + c[1]));
  const cells = [];
  for (let y = 0; y < st.size; y++) for (let x = 0; x < st.size; x++) {
    const v = st.board[y][x];
    const d = document.createElement('button');
    d.className = 'cell';
    if (v !== '.') { const s = document.createElement('span'); s.className = 'stone ' + LET[v]; d.appendChild(s); }
    if (winSet.has(x + ',' + y)) d.classList.add('win');
    const last = st.moveNo && lastMove && lastMove[0] === x && lastMove[1] === y;
    if (last) d.classList.add('last');
    d.addEventListener('click', () => tryMove(x, y, st));
    cells.push(d);
  }
  b.replaceChildren(...cells);
  // history
  $('#hist').replaceChildren(...(st.history || []).map(h => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot ${h.color}"></span>(${h.x},${h.y})`;
    return li;
  }));
  // my-seat hint
  const mine = Object.keys(tokens).filter(s => !st.players[s].resigned).map(s => st.players[s].color);
  $('#myseat-hint').textContent = mine.length ? `我执：${mine.join('/')}（点击落子）` : '（你不在座位上：从分享链接进入或加入）';
  // banner
  if (st.status !== 'playing') {
    $('#banner-t').textContent = st.status === 'draw' ? '平局！' : st.status + ' 🎉';
    $('#banner').classList.remove('hidden');
  } else $('#banner').classList.add('hidden');
  lastMove = st.history && st.history.length ? [st.history[st.history.length - 1].x, st.history[st.history.length - 1].y] : null;
}

let lastMove = null;
async function tryMove(x, y, st) {
  if (st.status !== 'playing' || !st.turn) return;
  const seat = Object.keys(tokens).find(s => st.players[s].color === st.turn && !st.players[s].resigned);
  if (seat === undefined) { alert('当前轮次你没有持有座位（座位凭证只属于创建者/加入者）'); return; }
  try {
    await api.call('POST', `/api/games/${cur.code}/moves`, { x, y }, tokens[seat]);
    poll();
  } catch (e) { alert('落子被拒绝：' + e.message); }
}

$('#btn-resign').addEventListener('click', async () => {
  if (!cur) return;
  let st; try { st = await api.call('GET', '/api/games/' + cur.code); } catch { return; }
  const seat = Object.keys(tokens).find(s => !st.players[s].resigned);
  if (seat === undefined) return alert('你没有在座');
  try { await api.call('POST', `/api/games/${cur.code}/resign`, undefined, tokens[seat]); poll(); } catch (e) { alert(e.message); }
});

$('#btn-bots').addEventListener('click', async () => {
  if (!cur) return;
  const st = await api.call('GET', '/api/games/' + cur.code);
  const missing = st.players.filter(p => p.role === 'bot' && !p.resigned);
  if (!missing.length) return alert('没有 bot 空位');
  $('#botcmd').textContent = missing.map(p =>
    `node bot/sample_bot.js --url ${location.origin} --code ${cur.code} --token ${tokens[p.seat] || '(需要该座位的seatToken)'}`).join('\n');
  $('#botcmd').classList.remove('hidden');
});

/* deep link ?join=code&seat&token */
const q = new URLSearchParams(location.search);
if (q.get('join')) {
  $('#join-code').value = q.get('join');
  if (q.get('seat')) $('#join-seat').value = q.get('seat');
  if (q.get('token')) $('#join-token').value = q.get('token');
  document.querySelector('[data-pane=join]').click();
}
