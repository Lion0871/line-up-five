'use strict';
/* Line-up Five — authoritative game server (Node 22 stdlib only). */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const VAR_DIR = process.env.VAR_DIR || path.join(ROOT, 'var', 'games');
const PUBLIC_DIR = path.join(ROOT, 'app', 'public');
const PORT = Number(process.env.PORT || 8787);
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 60);

const BOARD_SIZE = 13;               // fixed per rules
const MAX_PLAYERS = 4;
const COLORS = ['red', 'blue', 'green', 'yellow'];
const LETTER = { red: 'R', blue: 'B', green: 'G', yellow: 'Y' };
const LETTERS = { R: 'red', B: 'blue', G: 'green', Y: 'yellow' };
const MAX_MOVES_PER_SEAT = 40;       // time-limit rule: draw after everyone made 40 moves
const CODE_RE = /^[A-Z0-9]{6}$/;

const games = new Map();

/* ---------------- persistence ---------------- */
function persist(g) {
  const p = path.join(VAR_DIR, g.code + '.json');
  const t = p + '.tmp';
  fs.writeFileSync(t, JSON.stringify(g));
  fs.renameSync(t, p);
}
function loadGames() {
  fs.mkdirSync(VAR_DIR, { recursive: true });
  for (const f of fs.readdirSync(VAR_DIR)) {
    if (!f.endsWith('.json')) continue;
    const code = f.slice(0, -5);
    if (!CODE_RE.test(code)) continue;
    try {
      const g = JSON.parse(fs.readFileSync(path.join(VAR_DIR, f), 'utf8'));
      for (const s of g.seats) s.moves = g.history.filter(h => h.seat === s.seat).length;
      games.set(code, g);
    } catch (e) { console.error('skip', f, e.message); }
  }
}

/* ---------------- rules helpers ---------------- */
function inB(g, x, y) { return x >= 0 && y >= 0 && x < g.size && y < g.size; }
function lineCells(g, x, y, L) {
  // cells of the longest run through (x,y) containing letter L (assumes board[x] set)
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dx, dy] of dirs) {
    const cells = [[x, y]];
    for (const sg of [1, -1]) {
      let px = x + dx * sg, py = y + dy * sg;
      while (inB(g, px, py) && g.board[py][px] === L) { cells.push([px, py]); px += dx * sg; py += dy * sg; }
    }
    if (cells.length >= 5) return cells;
  }
  return null;
}
function runLen(g, x, y, L) {
  // longest run length that would result from placing letter L at (x,y) (cell assumed empty)
  g.board[y][x] = L;
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  let best = 0;
  for (const [dx, dy] of dirs) {
    let n = 1;
    for (const sg of [1, -1]) {
      let px = x + dx * sg, py = y + dy * sg;
      while (inB(g, px, py) && g.board[py][px] === L) { n++; px += dx * sg; py += dy * sg; }
    }
    if (n > best) best = n;
  }
  g.board[y][x] = '.';
  return best;
}
function openEnds(g, x, y, L) {
  // how many open ends the run through (x,y) has (run of any length)
  let ends = 0;
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dx, dy] of dirs) {
    for (const sg of [1, -1]) {
      let px = x + dx * sg, py = y + dy * sg;
      while (inB(g, px, py) && g.board[py][px] === L) { px += dx * sg; py += dy * sg; }
      if (inB(g, px, py) && g.board[py][px] === '.') ends++;
    }
  }
  return ends;
}
function activeSeats(g) { return g.seats.filter(s => !s.resigned); }
function fullBoard(g) { return g.board.every(row => row.every(c => c !== '.')); }
function nextTurn(g) {
  const n = g.seats.length;
  for (let i = 1; i <= n; i++) {
    const idx = (g.turnSeat + i) % n;
    const s = g.seats[idx];
    if (!s.resigned && s.moves < MAX_MOVES_PER_SEAT) { g.turnSeat = idx; return; }
  }
}
function endCheckAfterMove(g, seat, x, y) {
  const L = LETTER[seat.color];
  const cells = lineCells(g, x, y, L);
  if (cells) {
    g.status = seat.color + ' wins';
    g.winLine = cells;
    return;
  }
  const act = activeSeats(g);
  if (fullBoard(g) || (act.length > 0 && act.every(s => s.moves >= MAX_MOVES_PER_SEAT))) {
    g.status = 'draw';
    return;
  }
  nextTurn(g);
}

/* ---------------- views ---------------- */
function publicView(g) {
  return {
    code: g.code,
    size: g.size,
    startColor: g.startColor,
    players: g.seats.map(s => ({ seat: s.seat, color: s.color, role: s.role, resigned: s.resigned, moves: s.moves })),
    turn: g.status === 'playing' ? g.seats[g.turnSeat].color : null,
    board: g.board,
    status: g.status,
    winLine: g.winLine || null,
    moveNo: g.history.length,
  };
}
function leaderboard() {
  const counts = {};
  let draws = 0, finished = 0, playing = 0;
  for (const g of games.values()) {
    if (g.status === 'playing') { playing++; continue; }
    finished++;
    if (g.status === 'draw') { draws++; continue; }
    const c = g.status.replace(/ wins$/, '');
    counts[c] = (counts[c] || 0) + 1;
  }
  return { counts, draws, finished, playing };
}

/* ---------------- http plumbing ---------------- */
const rate = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let e = rate.get(ip);
  if (!e || now - e.t > 60000) { e = { t: now, n: 0 }; rate.set(ip, e); }
  e.n++;
  return e.n > RATE_LIMIT_PER_MIN;
}
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 65536) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('invalid json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function genCode() {
  const CS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CS[crypto.randomInt(36)];
    if (!games.has(c) && CODE_RE.test(c)) return c;
  }
}
function isInt(v) { return Number.isInteger(v); }

/* ---------------- handlers ---------------- */
function createGame(body) {
  const size = body.size === undefined ? BOARD_SIZE : body.size;
  if (!isInt(size) || size !== BOARD_SIZE) throw Object.assign(new Error('size must be 13'), { status: 400 });
  const humans = body.humans;
  if (!isInt(humans) || humans < 0 || humans > MAX_PLAYERS) throw Object.assign(new Error('humans must be 0..4'), { status: 400 });
  const players = body.players === undefined ? 4 : body.players;
  if (!isInt(players) || players < 2 || players > MAX_PLAYERS) throw Object.assign(new Error('players must be 2..4'), { status: 400 });
  if (humans > players) throw Object.assign(new Error('humans cannot exceed players'), { status: 400 });
  const startColor = body.startColor === undefined ? 'red' : body.startColor;
  if (!COLORS.slice(0, players).includes(startColor)) throw Object.assign(new Error('startColor must be one of ' + COLORS.slice(0, players).join(',')), { status: 400 });
  const seats = COLORS.slice(0, players).map((c, i) => ({
    seat: i, color: c, role: i < humans ? 'human' : 'bot',
    token: crypto.randomBytes(16).toString('hex'), resigned: false, moves: 0,
  }));
  const g = {
    code: genCode(),
    createdAt: new Date().toISOString(),
    size, players,
    board: Array.from({ length: size }, () => Array(size).fill('.')),
    history: [], status: 'playing', winLine: null,
    seats, startColor, turnSeat: seats.findIndex(s => s.color === startColor),
  };
  games.set(g.code, g);
  persist(g);
  return g;
}
function getGame(code) {
  const g = games.get(code);
  if (!g || !CODE_RE.test(code)) throw Object.assign(new Error('game not found'), { status: 404 });
  return g;
}
function seatByToken(g, tok) { return g.seats.find(s => s.token === tok); }
function authSeat(req, g) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer ([0-9a-f]{32})$/.exec(h);
  if (!m) throw Object.assign(new Error('missing or malformed Authorization: Bearer <seatToken>'), { status: 401 });
  const seat = seatByToken(g, m[1]);
  if (!seat) throw Object.assign(new Error('unknown seatToken for this game'), { status: 401 });
  return seat;
}

const STATIC_MAP = {
  '/': ['app/public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['app/public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app/public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['app/public/style.css', 'text/css; charset=utf-8'],
  '/bot.js': ['bot/sample_bot.js', 'text/plain; charset=utf-8'],
  '/docs': ['docs/API.md', 'text/plain; charset=utf-8'],
};

async function handle(req, res) {
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (rateLimited(ip)) return sendJson(res, 429, { error: 'rate limited (>' + RATE_LIMIT_PER_MIN + ' req/min)' });

  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const m = req.method;

  // API
  if (p === '/api/healthz' && (m === 'POST' || m === 'GET')) return sendJson(res, 200, { ok: true });
  if (p === '/api/leaderboard' && m === 'GET') return sendJson(res, 200, leaderboard());

  let mm;
  if (p === '/api/games' && m === 'POST') {
    const body = await readBody(req);
    const g = createGame(body);
    return sendJson(res, 201, {
      code: g.code,
      seats: g.seats.map(s => ({ seat: s.seat, color: s.color, role: s.role, seatToken: s.token })),
      startColor: g.startColor,
      botsFill: g.seats.some(s => s.role === 'bot'),
    });
  }
  if ((mm = p.match(/^\/api\/games\/([^/]+)$/)) && m === 'GET') {
    return sendJson(res, 200, publicView(getGame(mm[1])));
  }
  if ((mm = p.match(/^\/api\/games\/([^/]+)\/join$/)) && m === 'POST') {
    const g = getGame(mm[1]);
    const body = await readBody(req);
    if (!isInt(body.seat) || body.seat < 0 || body.seat >= g.players) throw Object.assign(new Error('seat must be 0..' + (g.players - 1)), { status: 400 });
    const seat = g.seats[body.seat];
    if (typeof body.seatToken !== 'string' || body.seatToken !== seat.token) throw Object.assign(new Error('bad seatToken (issued at game creation; no separate token on join)'), { status: 401 });
    if (seat.resigned) throw Object.assign(new Error('seat resigned'), { status: 410 });
    return sendJson(res, 200, { ok: true, seat: seat.seat, color: seat.color });
  }
  if ((mm = p.match(/^\/api\/games\/([^/]+)\/moves$/)) && m === 'POST') {
    const g = getGame(mm[1]);
    const seat = authSeat(req, g);
    if (g.status !== 'playing') throw Object.assign(new Error('game finished: ' + g.status), { status: 409 });
    if (seat.resigned) throw Object.assign(new Error('seat resigned'), { status: 410 });
    const body = await readBody(req);
    const { x, y } = body;
    if (!isInt(x) || !isInt(y) || x < 0 || y < 0 || x >= g.size || y >= g.size)
      throw Object.assign(new Error('x,y must be integers 0..' + (g.size - 1)), { status: 400 });
    if (g.turnSeat !== seat.seat)
      throw Object.assign(new Error('not your turn (turn: ' + g.seats[g.turnSeat].color + ')'), { status: 409 });
    if (seat.moves >= MAX_MOVES_PER_SEAT)
      throw Object.assign(new Error('seat already made ' + MAX_MOVES_PER_SEAT + ' moves'), { status: 409 });
    if (g.board[y][x] !== '.') throw Object.assign(new Error('cell already occupied'), { status: 400});
    g.board[y][x] = LETTER[seat.color];
    seat.moves++;
    g.history.push({ seat: seat.seat, color: seat.color, x, y, at: new Date().toISOString() });
    endCheckAfterMove(g, seat, x, y);
    persist(g);
    return sendJson(res, 200, Object.assign({ ok: true }, publicView(g)));
  }
  if ((mm = p.match(/^\/api\/games\/([^/]+)\/resign$/)) && m === 'POST') {
    const g = getGame(mm[1]);
    const seat = authSeat(req, g);
    if (g.status !== 'playing') throw Object.assign(new Error('game finished: ' + g.status), { status: 409 });
    if (seat.resigned) throw Object.assign(new Error('already resigned'), { status: 409 });
    seat.resigned = true;
    const act = activeSeats(g);
    if (act.length === 0) g.status = 'draw';
    else if (act.length === 1) g.status = act[0].color + ' wins';
    else if (g.turnSeat === seat.seat) nextTurn(g);
    persist(g);
    return sendJson(res, 200, Object.assign({ ok: true }, publicView(g)));
  }
  if ((mm = p.match(/^\/api\/replay\/([^/]+)$/)) && m === 'GET') {
    const g = getGame(mm[1]);
    return sendJson(res, 200, {
      code: g.code, createdAt: g.createdAt, size: g.size, players: g.seats.map(s => ({ seat: s.seat, color: s.color, role: s.role, resigned: s.resigned, moves: s.moves })),
      startColor: g.startColor, status: g.status, winLine: g.winLine || null, moveNo: g.history.length, history: g.history,
    });
  }
  if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found: ' + m + ' ' + p });

  // static
  if (m === 'GET' && STATIC_MAP[p]) {
    const [rel, ctype] = STATIC_MAP[p];
    try {
      const buf = fs.readFileSync(path.join(ROOT, rel));
      res.writeHead(200, { 'content-type': ctype });
      return res.end(buf);
    } catch { return sendJson(res, 500, { error: 'missing static file ' + rel }); }
  }
  return sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    sendJson(res, err.status || 500, { error: err.message || 'server error' });
  });
});

loadGames();
server.listen(PORT, () => console.log('lineup-five server on :' + PORT + ' games=' + games.size + ' rateLimit=' + RATE_LIMIT_PER_MIN + '/min'));
