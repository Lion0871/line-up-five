# Line-up Five

A small, polished **13×13 free-for-all gomoku** for 2–4 players — humans and AI agents
share the same match, no install, no login. One free move per turn: first to line up
**five in a row** (any direction) wins. No opening restrictions, no swap-overs; seats that
humans do not claim are filled by server bots. A match ends in minutes.

Rules (one paragraph): shared 13×13 board, 2–4 players (red/blue/green/yellow), one stone
per turn on an empty cell, first to connect 5 or more (horizontal, vertical, diagonal)
wins; if the board fills, or every player has made 40 moves without a five, the match is
a draw; no forbidden moves, no side swap — the creator picks the opening color (red by
default).

Zero dependencies: pure Node.js ≥ 22 (stdlib only). Server-restart never loses a match
(games persist to disk); the browser UI and the agent API are served by the same server.

Chinese rules: [docs/README-zh.md](docs/README-zh.md).

## Run it

```bash
node app/server.js            # bare metal: PORT=8787 node app/server.js
# or in a container:
docker run --rm -p 8787:8787 --read-only --tmpfs /tmp \
  -v $(pwd):/work -w /work node:22 node app/server.js
```

Open `http://<host>:8787/` on any phone browser — create a match, share the join code,
hand the same URL to agents. Empty seats can be filled with a bot at creation time.

## Agent API

Full docs: [`docs/API.md`](docs/API.md) (served live at `/docs`; the sample bot source is
served live at `/bot.js`). TL;DR:

```bash
curl -s -X POST $URL/api/games -H 'content-type: application/json' \
  -d '{"humans":2,"players":4}'          # -> join code + seatTokens
curl -s $URL/api/games/<code>            # public state (never exposes tokens)
curl -s -X POST $URL/api/games/<code>/move -H 'authorization: Bearer <seatToken>' \
  -H 'content-type: application/json' -d '{"seat":0,"x":6,"y":7}'
```

Sample bot (decision order: complete-5 → block-5 → make an open three):

```bash
node bot/sample_bot.js --url http://<host>:8787 --code <code> --token <seatToken>
```

## Tests

End-to-end suite (plays a full match against a live server: move validation, five
detection, replay, restart persistence, 429 rate limit, resign; 21 assertions):

```bash
bash tests/play_test.sh
```

## Fun bar

Four-way no-limit gomoku needs no dice: every turn is a live read of three threats —
your line, the nearest enemy four, and what the next seat can steal. Racing is punished
by four-way interference; there is no dominant opening strategy for all seats at once.

## Layout

```
app/server.js                   authoritative game server (HTTP/JSON)
app/public/{index,app,style}    plain vanilla front-end (touch-friendly, win-line highlight)
bot/sample_bot.js               public-API example player
docs/API.md                     endpoints + curl examples
tests/play_test.sh              e2e suite (21 assertions)
var/games/*.json                persisted match state (survives restarts)
VERSION                         app version
```
