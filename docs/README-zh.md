# Line-up Five（五子连线）

**规则一句话**：13×13 共享棋盘，2~4 人（红蓝绿黄）自由混战——每回合在空格放 1 子，先在任意方向（横/竖/斜）连成 ≥5 者胜；棋盘填满、或每人各下满 40 手仍未连五则平局；无禁手、无换后手（即“无禁手五目、4 人自由混战”），开局颜色由创建对局时指定（默认红先）。

零依赖纯 Node.js ≥22（全部 stdlib），无登录、无安装即可开玩（手机浏览器打开首页即可），服务器重启不丢局。

## 跑起来（容器版，交付规程）
```bash
# 代码目录 = docker 卷挂载来源 gamework:/work
docker run --rm -p 8787:8787 --memory 2g --cpus 2 --read-only \
  --tmpfs /tmp --tmpfs /home/node/.cache \
  -v gamework:/work -w /work gigbox:2 node app/server.js
# 浏览器打开 http://<host>:8787/   （大厅建局/加入码分享链接，手机可用）
```

裸机直接跑：`PORT=8787 node app/server.js`（对局文件自动读写 `var/games/`）。

## 玩 bot 补位
创建对局时选“部分座位挂 bot”，服务器自动补位，然后把 sample bot 挂到 bot 座位上（sample_bot 即公开 API 的可执行样例：①成5 ②堵5 ③造活三）：
```bash
node bot/sample_bot.js --url http://<host>:8787 --code <加入码> --token <该座位seatToken>
```

## API 与测试
- 全部端点与 curl 示例见 [docs/API.md](docs/API.md)（在线版：`GET /docs`）。
- 端到端测试（容器内真实跑通一局：落子校验、连五判定、replay、重启恢复、429、认输）：
```bash
docker run --rm --memory 2g --cpus 2 --read-only --tmpfs /tmp --tmpfs /home/node/.cache \
  -v gamework:/work -w /work gigbox:2 bash tests/play_test.sh
```

## 目录
```
app/server.js            权威游戏服务器（HTTP/JSON API）
app/public/{index,style,app} 纯 vanilla 前端（深色主题、触屏友好、胜线高亮）
bot/sample_bot.js        公开 API 玩家样例（决策 ①成5 ②堵5 ③活三）
docs/API.md              端点文档 + curl 示例
tests/play_test.sh       端到端测试；tests/client_player.js 测试用脚本座位客户端
var/games/*.json         对局落盘（重启读回）
VERSION                  app 版本
```
