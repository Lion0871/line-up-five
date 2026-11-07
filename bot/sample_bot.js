'use strict';
/*
 * Line-up Five — sample bot (public API player).
 *
 * This file is the executable API documentation. It shows how any client
 * (bot or scripted player) plays a game using only the public HTTP API.
 *
 * Decision priority (per game spec "bot fill-in":
 *   1) if placing a stone here completes MY five-in-a-row (>=5) -> play it (win now).
 *   2) else if an opponent would complete five-in-a-row at a cell -> occupy it (block).
 *   3) else make my own "open three" (extend my line; prefer highest run + open ends).
 *   fallback: nearest empty cell to board center.
 *
 * Usage:
 *   node bot/sample_bot.js --url http://HOST:PORT --code <6-CODE> --token <seatToken> [--poll 1500]
 *
 * The seatToken is issued by the server at game creation (POST /api/games);
 * the bot confirms its seat via POST /api/games/<code>/join (no new token: the
 * creation-time token IS the credential).
 */
const http = require('node:http');

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
}
const URL_BASE = arg('url', 'http://127.0.0.1:8787');
const CODE = arg('code', '');
const TOKEN = arg('token', '');
const POLL = Number(arg('poll', 1500));

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

/* --- rules helpers (same checks the server enforces) --- */
function inB(board, x, y) { return x >= 0 && y >= 0 && y < board.length && x < board.length; }
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
function openEnds(board, x, y, L) {
  let ends = 0;
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    for (const sg of [1, -1]) {
      let px = x + dx * sg, py = y + dy * sg;
      while (inB(board, px, py) && board[py][px] === L) { px += dx * sg; py += dy * sg; }
      if (inB(board, px, py) && board[py][px] === '.') ends++;
    }
  }
  return ends;
}
function empties(board) {
  const out = [];
  for (let y = 0; y < board.length; y++) for (let x = 0; x < board[y].length; x++) if (board[y][x] === '.') out.push([x, y]);
  return out;
}
function pickWin(board, L) {           // priority 1: complete >=5 myself
  for (const [x, y] of empties(board)) if (runLen(board, x, y, L) >= 5) return [x, y];
  return null;
}
function pickBlock(board, Ls) {       // priority 2: stop any opponent who would get >=5
  for (const [x, y] of empties(board))
    for (const L of Ls) if (runLen(board, x, y, L) >= 5) return [x, y];
  return null;
}
function pickThree(board, L) {        // priority 3: extend own line (open three), prefer center on ties
  let best = null, bestScore = -1;
  const c = (board.length - 1) / 2;
  for (const [x, y] of empties(board)) {
    const len = runLen(board, x, y, L);
    const score = len * 10 + openEnds(board, x, y, L) * 2;
    const cd = Math.abs(x - c) + Math.abs(y - c);
    if (score > bestScore || (score === bestScore && best && cd < Math.abs(best[0] - c) + Math.abs(best[1] - c))) {
      bestScore = score; best = [x, y];
    }
  }
  return best;
}

async function main() {
  if (!CODE || !TOKEN) { console.error('usage: --url --code --token [--poll]'); process.exit(2); }
  // join: creation-time seatToken is the credential; scan seats to find the one our token owns.
  let mySeat = -1;
  for (let s = 0; s <= 3; s++) {
    const r = await req('POST', '/api/games/' + CODE + '/join', { seat: s, seatToken: TOKEN });
    if (r.status === 200) { mySeat = s; break; }
  }
  if (mySeat < 0) { console.error('join failed: seatToken not valid for game', CODE); process.exit(1); }
  const st0 = await req('GET', '/api/games/' + CODE);
  const myColor = st0.json.players[mySeat].color;
  const L = ({ red: 'R', blue: 'B', green: 'G', yellow: 'Y' })[myColor];
  console.log(`[bot seat ${mySeat} ${myColor}] online, polling every ${POLL}ms`);

  for (;;) {
    const r = await req('GET', '/api/games/' + CODE);
    if (r.status !== 200) { await sleep(POLL); continue; }
    const st = r.json;
    if (st.status !== 'playing') { console.log(`[bot seat ${mySeat} ${myColor}] game finished: ${st.status}`); return; }
    if (st.turn !== myColor) { await sleep(POLL); continue; }
    const oppL = st.players.filter(pl => !pl.resigned && pl.color !== myColor).map(pl => ({ B: 'B', R: 'R', G: 'G', Y: 'Y' })[pl.color[0].toUpperCase()]);
    const board = st.board;
    const mv = pickWin(board, L) || pickBlock(board, oppL) || pickThree(board, L);
    if (!mv) { console.log('[bot] no legal move left; resigning'); await req('POST', '/api/games/' + CODE + '/resign', {}, { authorization: 'Bearer ' + TOKEN }); return; }
    const mr = await req('POST', '/api/games/' + CODE + '/moves', { x: mv[0], y: mv[1] }, { authorization: 'Bearer ' + TOKEN });
    if (mr.status !== 200) console.error('[bot] move rejected:', mr.status, mr.json && mr.json.error);
    await sleep(Math.min(POLL, 400));
  }
}
main().catch(e => { console.error('[bot] fatal:', e.message); process.exit(1); });
