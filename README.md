# 游戏大厅（飞行棋 / 五子棋 / 表白小游戏）

一个 Node.js 写的小型多人游戏站：房间、断线重连、聊天、语音提示、棋盘编辑器都在里面。

## 游戏

| 游戏 | 地址 |
| --- | --- |
| ✈️ 飞行棋（2～4 人，可加机器人） | `/ludo.html` |
| ⚫ 五子棋（2 人，可对机器人） | `/gomoku.html` |
| 💌 表白小游戏（单人） | `/love.html` |
| 🏠 游戏大厅 | `/` |

## 部署到 Render（免费、电脑可关）

1. 在 GitHub 新建一个仓库（Public 或 Private 都行）
2. 把本目录所有文件上传上去（网页版直接拖拽文件夹即可）
3. 打开 https://render.com → 用 GitHub 登录 → **New +** → **Web Service**
4. 选刚才的仓库 → Render 会自动识别 `Dockerfile` 和 `render.yaml`
5. Instance Type 选 **Free** → **Create Web Service**
6. 等 2～3 分钟，地址形如 `https://ludo-site-xxxx.onrender.com`

> 免费实例闲置 15 分钟会休眠，下次打开需要等 30～60 秒，属正常现象。

## 本地运行

```bash
node standalone/server.mjs --port 8787
# 打开 http://127.0.0.1:8787
```

需要 Node 18 以上（推荐 20）。

## 站长功能

- 大厅页脚点「站长模式」，或在地址后加 `?admin=1`
- 默认口令在 `standalone/data/admin.txt`（请自行修改成你自己的）
- 可以下架 / 恢复大厅里的游戏，状态保存在 `standalone/data/games.json`

## 结构

```
standalone/server.mjs   HTTP 服务、静态文件、站长接口
standalone/public/      前端页面
ludo-chess/hub.js       房间、座位、聊天、长轮询
ludo-chess/engine.js    飞行棋规则
ludo-chess/gomoku.js    五子棋规则
```
