'use strict';
/*
 * tests/client_player.js — scripted seat client used by play_test.sh.
 * Acts like a human player over the public API (this is what curl + a small
 * loop would do; keeping it as a node file makes the test deterministic).
 *
 * Decision order on your turn:
 *   1) win now (would complete >=5 for my color)
 *   2) block any NON-friendly opponent's four (they would complete >=5)
 *   3) play next planned cell (skipping occupied ones)
 *   4) block a friendly-threatening open three from non-friendlies
 *   5) fallback: nearest empty cell to center
 *
 * --friendly can be given twice: e.g. seat0 uses --friendly blue --friendly red
 * meaning colors that must NOT be defended-blocked by this client.
 */
const http = require('node:http');
const args = process.argv.slice(2);
function argAll(name) { return args.map((a, i) => (a === '--' + name ? args[i + 1] : null)).filter(Boolean); }
function arg(name, dflt) { const v = argAll(name); return v.length ? v[0] : dflt; }
const URL_BASE = arg('url', 'http://127.0.0.1:8787');
const CODE = arg('code', '');
const TOKEN = arg('token', '');
const SEAT = Number(arg('seat', 0));
const FRIENDLY = argAll('friendly');           // colors this client never blocks
const PLAN = (arg('plan', '') || '').split(';').map(s => s.trim()).filter(Boolean)
  .map(s => s.split(',').map(Number));
const POLL = Number(arg('poll', 800));

function req(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(URL_BASE + p);
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      method, hostname: u.hostname, port: u.port || 80, path: u.pathname,
      headers: Object.assign({ 'content-type': 'application/json' }, data ? { 'content-length': Buffer.byteLength(data) } : {}, headers || {}),
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function inB(board, x, y) { return x >= 0 && y >= 0 && y < board.length && x < board[0].length && x >= 0; }
function runLen(board, x, y, L) {
  board[y][x] = L;
  let best = 0;
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    let n = 1;
    for (const sg of [1, -1]) {
      let px = x + dx * sg, py = y + dy * sg;
      while (inB(board, px, py) && board[py][px] === L) { n++; px += dx * sg; py += dy * sg; }
    }
    best = Math.max(best, n);
  }
  board[y][x] = '.';
  return best;
}
function isOpenThree(board, x, y, L) {
  // placing here makes an open three exactly (len 3, two open ends on that run)
  board[y][x] = L;
  let hit = false;
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    let n = 1;
    for (const sg of [1, -1]) {
      let px = x + dx * sg, py = y + dy * sg;
      while (inB(board, px, py) && board[py][px] === L) { n++; px += dx * sg; py += dy * sg; }
      var openCell = inB(board, px, py) && board[py][px] === '.';
      if (n >= 3 && openCell) { /* count ends below */ }
    }
    if (n === 3) {
      let ends = 0;
      for (const sg of [1, -1]) {
        let px = x + dx * sg, py = y + dy * sg;
        while (inB(board, px, py) && board[py][px] === L) { px += dx * sg; py += dy * sg; }
        if (inB(board, px, py) && board[py][px] === '.') ends++;
      }
      if (ends === 2) hit = true;
    }
  }
  board[y][x] = '.';
  return hit;
}
function empties(board) {
  const out = [];
  for (let y = 0; y < board.length; y++) for (let x = 0; x < board[y].length; x++) if (board[y][x] === '.') out.push([x, y]);
  return out;
}
const LET = c => ({ red: 'R', blue: 'B', green: 'G', yellow: 'Y' })[c];

async function main() {
  let used = 0;
  console.log(`[client seat ${SEAT}] online plan=${PLAN.length}`);
  for (;;) {
    const r = await req('GET', '/api/games/' + CODE);
    if (r.status !== 200) { console.error('[client] state error', r.status, r.json); await sleep(POLL); continue; }
    const st = r.json;
    if (st.status !== 'playing') { console.log(`[client seat ${SEAT}] finished: ${st.status}`); return; }
    const me = st.players[SEAT];
    if (st.turn !== me.color) { await sleep(POLL); continue; }
    const L = LET(me.color);
    const rivals = st.players.filter(p => !p.resigned && p.color !== me.color && !FRIENDLY.includes(p.color)).map(p => LET(p.color));
    const board = st.board;
    let mv = null;
    for (const [x, y] of empties(board)) if (runLen(board, x, y, L) >= 5) { mv = [x, y]; break; }          // win now
    if (!mv) for (const [x, y] of empties(board)) {                                                        // block four
      for (const R of rivals) if (runLen(board, x, y, R) >= 5) { mv = [x, y]; break; }
      if (mv) break;
    }
    if (!mv) while (used < PLAN.length) {                                                                 // plan
      const [px, py] = PLAN[used++];
      if (inB(board, px, py) && board[py][px] === '.') { mv = [px, py]; break; }
    }
    if (!mv) for (const [x, y] of empties(board)) {                                                        // block open three
      for (const R of rivals) if (isOpenThree(board, x, y, R)) { mv = [x, y]; break; }
      if (mv) break;
    }
    if (!mv) {
      const c = (board.length - 1) / 2;
      mv = empties(board).sort((a, b) => (Math.abs(a[0] - c) + Math.abs(a[1] - c)) - (Math.abs(b[0] - c) + Math.abs(b[1] - c)))[0];
    }
    const mr = await req('POST', '/api/games/' + CODE + '/moves', { x: mv[0], y: mv[1] }, { authorization: 'Bearer ' + TOKEN });
    if (mr.status === 409) { await sleep(150); continue; }   // stale turn — refresh
    if (mr.status !== 200) { console.error(`[client seat ${SEAT}] move ${mv} rejected`, mr.status, mr.json && mr.json.error); await sleep(POLL); continue; }
    console.log(`[client seat ${SEAT} ${me.color}] play (${mv[0]},${mv[1]}) -> ${mr.json.status !== 'playing' ? 'FINAL: ' + mr.json.status : 'ok'}`);
  }
}
main().catch(e => { console.error('[client] fatal:', e.message); process.exit(1); });
