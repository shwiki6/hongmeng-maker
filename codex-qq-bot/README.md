# Codex QQ Bot

独立的 QQ 官方机器人项目：**QQ 官方 API 收发消息 → 调用本机 Codex CLI 交互**。

与 OpenClaw **完全无关**。OpenClaw 版 QQ 机器人仅作为协议/接入方式参考。

## 架构

```text
QQ 用户/群
  │  WebSocket Gateway (官方)
  ▼
@tencent-connect/qqbot-nodejs
  │  message event
  ▼
Codex QQ Bot (本项目)
  │  codex exec / codex exec resume <session>
  ▼
Codex CLI → 模型/工具执行
  │
  ▼
回复到 QQ C2C / 群
```

## 功能

- QQ 官方机器人私聊（C2C）与群聊（官方 Gateway + FULL_INTENTS）
- 每个 QQ 用户/群独立映射一个 Codex session（`codex exec resume`）
- C2C 流式过程气泡 + 最终完整 `sendText` 回复
- C2C 使用官方 `stream_messages` 实时流式；群聊受 QQ 官方接口限制只发送低频状态，不支持群流式
- 入站富媒体：图片/语音/视频/文件下载；图片经 `codex -i` 注入
- 出站富媒体：从 Codex 回复中的本地绝对路径自动 `sendImage/sendFile/...`；群聊多个文件自动打包为一个 ZIP
- 按钮交互：`INTERACTION_CREATE` + 快捷键盘（/help、/status、/new…）
- 消息撤回 `/recall`、C2C 唤醒 `/wakeup`
- 群/好友生命周期事件日志（可选主动通知）
- 被动回复限流：超额自动降级为主动消息
- 持久 HTTP 服务 `/serve`（不随 codex 回合结束退出）
- 扫码绑定 AppID/AppSecret（`@tencent-connect/qqbot-connector`）
- 本地会话持久化：`data/sessions.json`

## 环境要求

- Node.js >= 18
- 已安装并可运行 `codex`（本机可用 `/root/.openclaw/bin/codex` 或 PATH 中的 `codex`）
- QQ 开放平台机器人凭证：https://q.qq.com/

## 快速开始

```bash
cd /root/openclaw-cli-workspace/projects/codex-qq-bot
npm install
cp .env.example .env
```

### 方式 A：扫码绑定

```bash
npm run bind
```

### 方式 B：手动填写 `.env`

```bash
QQBOT_APP_ID=你的AppID
QQBOT_CLIENT_SECRET=你的AppSecret
CODEX_BIN=codex
CODEX_WORKDIR=/root/openclaw-cli-workspace
CODEX_BYPASS_APPROVALS=true
```

启动：

```bash
npm run doctor
npm start
```

## QQ 命令

| 命令 | 说明 |
| --- | --- |
| `/help` | 帮助 + 快捷按钮 |
| `/kb` | 仅显示快捷按钮 |
| `/ping` | 探活 |
| `/me` | 查看 openid |
| `/new` `/reset` | 新 Codex 会话 |
| `/status` | 当前会话/工作目录/模型 |
| `/cd <path>` | 设置该 peer 的 Codex 工作目录 |
| `/model` | 查看模型配置说明（跟随本机 Codex CLI） |
| `/serve <dir> [port]` | 启动持久静态网站 |
| `/services` | 查看持久服务 |
| `/stop-serve <port|id>` | 停止持久服务 |
| `/recall [id]` | 撤回最近/指定机器人消息 |
| `/wakeup <text>` | C2C 主动唤醒（30 天窗口） |
| `/send-image <path>` | 发送本地图片 |
| `/send-file <path>` | 发送本地文件 |

普通文本/图片消息会转发给 Codex CLI。群聊默认需要 @ 机器人（`QQBOT_REQUIRE_MENTION=true`）。

群聊中，机器人会按群成员分配稳定的人物 ID（如 `人物001`、`人物002`）。本条消息的发言者和被 `@` 的成员会注入 Codex 提示词；映射保存在 `data/sessions.json`，只在当前群内有效。群聊 Codex 会话和队列按 `群 + 人物 ID` 分配：未 `@` 其他成员时使用发言者会话，`@` 某成员时使用该成员会话；不同人物可按全局 `CONCURRENCY` 并行执行，回复仍回到原群。

## 会话策略

- peer key：`c2c:<openid>` 或 `group:<groupOpenid>`
- 首次消息：`codex exec ... --json -o <file> <prompt>`（模型由本机 Codex CLI 配置决定）
- 后续消息：`codex exec ... resume <sessionId> --json -o <file> <prompt>`（模型由本机 Codex CLI 会话决定）
- session id 从 Codex JSONL 的 `session_meta.session_id` 解析

## 安全建议

- 生产环境请配置：
  ```bash
  QQBOT_ALLOW_FROM=openid1,openid2
  QQBOT_GROUP_ALLOW_FROM=openid1
  ```
- `CODEX_BYPASS_APPROVALS=true` 仅建议在本机已受控环境使用
- 不要提交 `.env` 与 `data/sessions.json` 中的敏感信息

## 目录

```text
src/
  index.js          入口
  bot.js            QQ 事件/命令/交互/流式/媒体
  codex-runner.js   Codex CLI 封装
  media.js          附件下载与出站路径解析
  keyboard.js       官方 inline keyboard
  guild-api.js      频道 OpenAPI 全量封装
  guild-commands.js 频道管理命令
  service-manager.js 持久 HTTP 服务
  session-store.js  会话映射
  config.js         配置
scripts/
  bind-qq.js        扫码绑定
  doctor.js         环境检查
  supervise.sh      Android/PRoot 守护
  persist-http-server.py  持久静态站
data/sessions.json  运行时生成
media/              入站附件缓存
data/gateway-session.json  QQ Gateway RESUME 会话
```

## 说明

- 本项目只依赖：
  - `@tencent-connect/qqbot-nodejs`（官方协议 SDK）
  - `@tencent-connect/qqbot-connector`（扫码拿凭证）
  - 本机 `codex` CLI
- 不依赖 `openclaw`、`@openclaw/qqbot` 或 OpenClaw gateway。


## 频道功能

基于 QQ 官方频道 OpenAPI（路径对齐 botgo `openapi/v1`），通过 `bot.api` 调用：

- 用户/频道：`/g-me` `/g-list` `/g-info`
- 子频道 CRUD：`/g-channels` `/g-channel-create` `/g-channel-edit` `/g-channel-del`
- 成员：`/g-members` `/g-member` `/g-kick`
- 身份组：`/g-roles` `/g-role-create|edit|del` `/g-role-add|rm`
- 子频道权限：`/g-perm-user` `/g-perm-role` 及 set
- 禁言：`/g-mute` `/g-mute-user` `/g-mute-users`
- 公告/精华：`/g-announce` `/g-gannounce` `/g-pin(s)`
- 日程：`/g-schedules` `/g-schedule-create|del`
- 消息/表态/私信：`/g-say` `/g-msg` `/g-react` `/g-dm`
- 音频上麦：`/g-mic-on|off` `/g-audio`
- 接口授权：`/g-api-perm` `/g-api-demand`

完整列表见 `/g-help`。多数写操作需要机器人在该频道具备对应 API 权限。
