#!/usr/bin/env bash
# play_test.sh — end-to-end test for Line-up Five. Run INSIDE the gigbox container:
#   docker run --rm --memory 2g --cpus 2 --read-only --tmpfs /tmp --tmpfs /home/node/.cache \
#     -v gamework:/work -w /work gigbox:2 bash tests/play_test.sh
set -u
cd "$(dirname "$0")/.."
PORT=${TEST_PORT:-8791}
BASE="http://127.0.0.1:${PORT}"
PASS=0; FAIL=0
PIDS=()
SAY(){ printf '\n== %s ==\n' "$*"; }
OK(){ printf 'PASS: %s\n' "$*"; PASS=$((PASS+1)); }
BAD(){ printf 'FAIL: %s\n' "$*"; FAIL=$((FAIL+1)); }
# json-eval: echo <json> | jget '<JS expr using o>'  (o = parsed json; ".x" shorthand too)
jget(){ node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const o=JSON.parse(d);const src=process.argv[1];const expr=src.startsWith(".")?("o"+src):src;const v=(new Function("o","return ("+expr+")"))(o);console.log(v===undefined?"?":v);}catch(e){console.log("PARSE_ERR:"+e.message+"|"+d.slice(0,200));}});' "$1"; }

cleanup(){ SAY "cleanup"; for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null; done; sleep 0.5; for pid in "${PIDS[@]:-}"; do kill -9 "$pid" 2>/dev/null; done; rm -rf "$LOGDIR"; }
trap cleanup EXIT

start_server(){ # args: extra env passed inline via `env`
  RATE="${1:-100000}"
  PORT=$PORT RATE_LIMIT_PER_MIN=$RATE node app/server.js >>"$LOGDIR/server.log" 2>&1 &
  PIDS+=($!)
  for i in $(seq 1 40); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/healthz)" = "200" ] && return 0
    sleep 0.25
  done
  BAD "server did not come up"; cat "$LOGDIR/server.log"; exit 1
}

LOGDIR=$(mktemp -d /work/var-testlogs.XXXX 2>/dev/null || mktemp -d)
SAY "phase A: boot with default rate limit (60/min), check infra + validation + resign + 429"
start_server 60

H=$(curl -s -X POST $BASE/api/healthz)
[ "$H" = '{"ok":true}' ] && OK "healthz $H" || BAD "healthz got: $H"

GR=$(curl -s -X POST $BASE/api/games -H 'content-type: application/json' -d '{"humans":2,"size":13,"players":4}')
RC=$(echo "$GR" | jget '.code'); RT0=$(echo "$GR" | jget '.seats[0].seatToken'); RT1=$(echo "$GR" | jget '.seats[1].seatToken')
[ -n "$RC" ] && [ ${#RC} -eq 6 ] && OK "create game code=$RC seats ok" || BAD "create got: $GR"

# validation: bad seatToken -> 401
C=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/games/$RC/moves -H "authorization: Bearer 0000000000000000000000000000dead" -d '{"x":5,"y":5}')
[ "$C" = "401" ] && OK "bad seatToken rejected ($C)" || BAD "bad token got $C"
# validation: out of bounds -> 400
C=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/games/$RC/moves -H "authorization: Bearer $RT0" -d '{"x":13,"y":0}')
[ "$C" = "400" ] && OK "out-of-bounds rejected ($C)" || BAD "oob got $C"
C=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/games/$RC/moves -H "authorization: Bearer $RT0" -d '{"x":-1,"y":7}')
[ "$C" = "400" ] && OK "negative coord rejected ($C)" || BAD "neg got $C"
# first legal move (red), then not-your-turn -> 409, occupied -> 4xx
C=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/games/$RC/moves -H "authorization: Bearer $RT0" -d '{"x":11,"y":11}')
[ "$C" = "200" ] && OK "legal move accepted" || BAD "first move got $C"
C=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/games/$RC/moves -H "authorization: Bearer $RT0" -d '{"x":2,"y":2}')
[ "$C" = "409" ] && OK "wrong-turn move rejected ($C)" || BAD "wrong turn got $C"
C=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/games/$RC/moves -H "authorization: Bearer $RT1" -d '{"x":11,"y":11}')
[ "${C:0:1}" = "4" ] && OK "occupied cell rejected ($C)" || BAD "occupied got $C"
# public view must not leak tokens
curl -s $BASE/api/games/$RC | grep -q "$RT0" && BAD "public view leaked seatToken" || OK "public view has no tokens"
# resign
R=$(curl -s -X POST $BASE/api/games/$RC/resign -H "authorization: Bearer $RT1")
TURN=$(echo "$R" | jget '.turn')
RES=$(echo "$R" | jget '.players[1].resigned')
[ "$RES" = "true" ] && [ "$TURN" != "blue" ] && OK "resign ok (resigned=$RES turn=$TURN)" || BAD "resign: $R"
C=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/games/$RC/moves -H "authorization: Bearer $RT1" -d '{"x":1,"y":1}')
[ "${C:0:1}" = "4" ] && OK "resigned seat cannot move ($C)" || BAD "resigned move got $C"
# rate limit: burst past 60/min -> at least one 429
CODES=$(for i in $(seq 1 61); do curl -s -o /dev/null -w '%{http_code} ' $BASE/api/healthz; done)
echo "$CODES" | grep -q 429 && OK "burst over 60/min hit 429" || BAD "no 429 in burst: $CODES"
SAY "phase A done (PASS=$PASS FAIL=$FAIL)"; kill ${PIDS[-1]} 2>/dev/null; wait ${PIDS[-1]} 2>/dev/null; PIDS=(${PIDS[@]:0:${#PIDS[@]}-1})

SAY "phase B: 4-seat game, 2 seats = sample bot, play to five-in-a-row"
start_server 100000
GW=$(curl -s -X POST $BASE/api/games -H 'content-type: application/json' -d '{"humans":2,"size":13,"players":4,"startColor":"red"}')
WC=$(echo "$GW" | jget '.code'); WT=$(echo "$GW" | jget 'o.seats.map(s=>s.seatToken).join(",")')
T0=$(echo "$WT" | cut -d, -f1); T1=$(echo "$WT" | cut -d, -f2); T2=$(echo "$WT" | cut -d, -f3); T3=$(echo "$WT" | cut -d, -f4)
BF=$(echo "$GW" | jget '.botsFill')
[ "$BF" = "true" ] && OK "botsFill=true for humans=2 (seats 2,3 = bot)" || BAD "botsFill got $BF"

node bot/sample_bot.js --url $BASE --code $WC --token $T2 --poll 1200 & PIDS+=($!)
node bot/sample_bot.js --url $BASE --code $WC --token $T3 --poll 1200 & PIDS+=($!)
node tests/client_player.js --url $BASE --code $WC --token $T0 --seat 0 --friendly blue --poll 700 --plan "11,2;11,3;11,4;8,1;9,1;10,1;11,1" & PIDS+=($!)
node tests/client_player.js --url $BASE --code $WC --token $T1 --seat 1 --friendly red --poll 700 --plan "0,0;1,0;2,0;3,0;4,0;5,0" & PIDS+=($!)

# red plans a corner double-FOUR: vertical (11,1..4) + horizontal (8,1..11,1) via intersection (11,1);
# completion cells are (11,0),(11,5),(7,1),(12,1) — the two bots can stop only two of four.
for i in $(seq 1 240); do
  ST=$(curl -s $BASE/api/games/$WC)
  STT=$(echo "$ST" | jget '.status'); MV=$(echo "$ST" | jget '.moveNo')
  [ "$STT" != "playing" ] && break
  sleep 0.5
done
echo "final state: status=$STT moveNo=$MV"
[ "$STT" = "red wins" ] && OK "five-in-a-row detected: $STT" || BAD "expected 'red wins', got '$STT'"
WL=$(echo "$ST" | jget 'o.winLine?o.winLine.length:0'); [ "$WL" -ge 5 ] 2>/dev/null && OK "winLine highlight len=$WL" || BAD "winLine=$WL"

SAY "replay completeness"
RP=$(curl -s $BASE/api/replay/$WC)
RH=$(echo "$RP" | jget 'o.history.length'); RM=$(echo "$RP" | jget '.moveNo')
[ "$RH" = "$MV" ] && OK "replay history=$RH == moveNo=$RM" || BAD "replay hist $RH != $MV"
HASAT=$(echo "$RP" | jget 'o.history.every(h=>h.at&&h.color&&h.seat!==undefined)')
[ "$HASAT" = "true" ] && OK "history entries carry seat/color/at" || BAD "history fields missing: $HASAT"

SAY "leaderboard"
LB=$(curl -s $BASE/api/leaderboard)
echo "leaderboard: $LB"
LR=$(echo "$LB" | jget '(o.counts.red||0)>=1')
[ "$LR" = "true" ] && OK "leaderboard red wins >= 1" || BAD "leaderboard: $LB"

SAY "restart persistence: kill server, relaunch, game must survive"
kill ${PIDS[-1]} 2>/dev/null; wait ${PIDS[-1]} 2>/dev/null; PIDS=(${PIDS[@]:0:${#PIDS[@]}-1})
start_server 100000
ST2=$(curl -s $BASE/api/games/$WC)
S2=$(echo "$ST2" | jget '.status'); M2=$(echo "$ST2" | jget '.moveNo')
[ "$S2" = "red wins" ] && [ "$M2" = "$MV" ] && OK "after restart: status=$S2 moveNo=$M2 (unchanged)" || BAD "after restart: $S2 / $M2 vs $MV"
curl -s $BASE/api/leaderboard | grep -q '"red":' && OK "leaderboard persists across restart" || BAD "leaderboard lost"
N=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/games -d '{"humans":4,"size":13}' -H 'content-type: application/json')
[ "$N" = "201" ] && OK "can still create games after restart" || BAD "create after restart $N"

SAY "RESULT: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ] && echo "ALL TESTS PASSED" && exit 0
echo "TESTS FAILED"; exit 1
