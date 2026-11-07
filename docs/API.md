# Line-up Five — HTTP/JSON API (v1.0.0)

Base URL: `http://<host>:<port>`（默认 8787，可用环境变量 `PORT` 调整）。
所有 JSON 请求带 `content-type: application/json`。同源部署，不配 CORS。
单 IP 速率限制：>60 req/min 返回 429（可用 `RATE_LIMIT_PER_MIN` 调整）。

服务器权威校验一切落子；公开查询接口绝不返回 seatToken。

## 凭证说明
- 创建对局时服务器为每个座位签发 32 位 hex 的 `seatToken`（响应 201 中返回）。
- 创建者把对应座位的 token 发给朋友/bot；**join 不签发新 token**（简化：创建时的 seatToken 就是凭证）。
- 落子/认输需 `Authorization: Bearer <seatToken>`。

## POST /api/healthz
liveness 探针（GET 也支持）。
```bash
curl -s -X POST http://localhost:8787/api/healthz
# -> {"ok":true}
```

## POST /api/games  — 创建对局（匹配码大厅）
body: `{"humans":0..4, "size":13, "players":2..4(默认4), "startColor":"red|blue|green|yellow"(可选)`}`
未被人占用的座位自动挂 bot（`botsFill:true`）。size 固定 13。
```bash
curl -s -X POST http://localhost:8787/api/games \
  -H 'content-type: application/json' -d '{"humans":2,"size":13,"players":4}'
# -> 201 {"code":"A1B2C3",
#        "seats":[{"seat":0,"color":"red","role":"human","seatToken":"<32hex>"}, ...4 seats],
#        "startColor":"red", "botsFill":true}
```
分享加入：把某座位的 `seatToken` 发给对方；前端链接 `/?join=<code>&seat=N&token=<32hex>`。

## GET /api/games/<code>  — 公开状态（不含 token）
```bash
curl -s http://localhost:8787/api/games/A1B2C3
# -> {"code","size","startColor",
#     "players":[{"seat":0,"color":"red","role":"human|bot","resigned":false,"moves":3},...],
#     "turn":"red" | null,
#     "board": 13x13 二维字符串数组（"." 空，R/B/G/Y 棋子），
#     "status":"playing|red wins|blue wins|green wins|yellow wins|draw",
#     "winLine":[[x,y],...] | null,   # 胜方连线的格（>=5），用于前端高亮
#     "moveNo":N}
```

## POST /api/games/<code>/join  — 认领座位（不签发新 token）
body: `{"seat":0..3, "seatToken":"<32hex>"}`；token 与创建时签发值比对。
```bash
curl -s -X POST http://localhost:8787/api/games/A1B2C3/join \
  -H 'content-type: application/json' -d '{"seat":2,"seatToken":"<32hex>"}'
# -> 200 {"ok":true,"seat":2,"color":"green"}
```

## POST /api/games/<code>/moves  — 落子
header `Authorization: Bearer <seatToken>`；body `{"x":0..12,"y":0..12}`。
非法情形（未带/错误 token 401；越界/占位/非整数 400；非你的回合/终局/已认输/达到40手上限 409/410）。
```bash
curl -s -X POST http://localhost:8787/api/games/A1B2C3/moves \
  -H 'authorization: Bearer <32hex>' -d '{"x":6,"y":6}'
# -> 200 {"ok":true, ...同 GET 状态...}
# -> 409 {"error":"not your turn (turn: blue)"}
```

## POST /api/games/<code>/resign  — 认输退出（剩余玩家继续）
header `Authorization: Bearer <seatToken>`。剩 1 人则该色获胜；全认输则平局。
```bash
curl -s -X POST http://localhost:8787/api/games/A1B2C3/resign -H 'authorization: Bearer <32hex>'
```

## GET /api/replay/<code>  — 完整对局记录
```bash
curl -s http://localhost:8787/api/replay/A1B2C3
# -> {"code","createdAt","players","startColor","status","winLine","moveNo",
#     "history":[{"seat":0,"color":"red","x":6,"y":6,"at":"ISO时间"},...]}
```

## GET /api/leaderboard  — 简单统计（按颜色胜场，来自已落盘对局）
```bash
curl -s http://localhost:8787/api/leaderboard
# -> {"counts":{"red":2,"green":1},"draws":0,"finished":3,"playing":5}
```

## 静态
- `GET /` → index.html（大厅+棋盘）
- `GET /style.css`、`GET /app.js` → 前端资源
- `GET /docs` → 本 API.md（纯文本）
- `GET /bot.js` → sample_bot.js 源码（纯文本）

## 持久化
每局即时落盘 `var/games/<code>.json`；服务器重启读回全部对局（进行中对局继续、终局状态保留）。

## 样例 bot（可执行 API 文档）
`bot/sample_bot.js`：join→轮询→①自己能成5就落 ②对手要成5就堵 ③造活三→否则占中心。
```bash
node bot/sample_bot.js --url http://localhost:8787 --code A1B2C3 --token <32hex>
```
