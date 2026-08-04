# 卡密管理系统 · 接口使用文档

## 基础说明

| 项目 | 说明 |
|------|------|
| 运行环境 | PHP 8.x + SQLite（PDO 驱动） |
| 数据格式 | 全部接口返回 JSON，`Content-Type: application/json; charset=utf-8` |
| 请求格式 | 卡密接口（generate/validate/redeem/activate）用 `application/x-www-form-urlencoded`；登录/设置类（auth/change_credentials/wechat_settings/invite）用 `application/json` |
| 会话管理 | 登录状态通过 PHP Session 保持（HttpOnly + SameSite=Lax，登录后 regenerate id） |
| 默认地址 | 服务根目录即项目根目录，PHP 内置服务器启动方式：**`php -S 0.0.0.0:8080 router.php`** |
| 管理员凭据 | 用户名 `admin`；密码为部署时随机生成，存于 `data/admin_config.json`（bcrypt 哈希）。**文档不记录明文**，遗失请用下方命令重置 |

### 鉴权总览

| 接口 | 所需权限 |
|------|----------|
| `init.php` | **管理员 Session**（仅建表/迁移，幂等） |
| `generate.php` / `list.php` / `cards.php` / `change_credentials.php` | **管理员 Session** |
| `validate.php` / `redeem.php` | **管理员 Session 或 API Token** |
| `wechat_settings.php` / `invite.php` / `stats.php` | **管理员 Session** |
| `activate.php` | **无**（App 启动激活并核销专用） |
| `auth.php` | 无（登录入口） |

API Token 存放于 `data/admin_config.json` 的 `api_token` 字段，供外部业务系统调用验证/核销接口。两种传递方式均可：

```
X-API-Token: <token>
Authorization: Bearer <token>
```

> Token 使用 `hash_equals()` 常量时间比较，防时序侧信道。

### 外部系统接入指南（必读）

1. **前置：先配置 API Token。** `admin_config.json` 默认**没有** `api_token` 字段，未配置时调用 `validate.php` / `redeem.php` 一律返回 `401`。首次使用先在服务器执行：
   ```bash
   php -r '$p="data/admin_config.json"; $c=json_decode(file_get_contents($p),true);
   $c["api_token"]??=bin2hex(random_bytes(32));
   file_put_contents($p, json_encode($c, JSON_UNESCAPED_UNICODE|JSON_PRETTY_PRINT));
   echo "API Token: ", $c["api_token"], PHP_EOL;'
   ```
2. **三个消费/验证接口的分工（容易用错）**：
   | 接口 | 用途 | 是否把卡标记为「已使用」 |
   |------|------|--------------------------|
   | `validate.php` | 只查卡密状态 | **否** |
   | `redeem.php` | 消费/核销一张卡（App 兑换、业务核销都走它） | **是**（后台会显示「已使用」） |
   | `activate.php` | App 启动时激活并核销（公开接口） | **是** |
3. App 必须调用 `activate.php`，不要在 APK 中调用带 API Token 的 `redeem.php`。`activate.php` 会在服务端原子核销并更新后台状态，且不泄露管理员凭据。
4. 业务失败的判定：`validate.php` 看 `valid` 字段、`redeem.php` 看 `redeemed` 字段、`activate.php` 看 `activated` 字段（这些接口在业务失败时 `success` 仍为 `true`，不要用 `success` 判断业务结果）。

### 部署与文件保护（重要）

数据库与管理员凭据已移入 **`data/`** 目录，绝不可被 Web 直接下载：

```
data/
├── card_keys.db        # SQLite 数据库
├── admin_config.json   # 用户名 + 密码哈希 + API Token
└── .htaccess           # Require all denied
```

- **php -S**：必须带路由脚本 `php -S 0.0.0.0:8080 router.php`，由 `router.php` 拦截 `data/` 与 `.db`/`.json`。
- **Apache**：根目录 `.htaccess` 与 `data/.htaccess` 已就绪，需开启 `AllowOverride All`。
- **Nginx**：`.htaccess` 无效，请在站点配置中加入：

```nginx
location ^~ /data/ { deny all; return 403; }
location ~* \.(db|db-wal|db-shm|sqlite|json)$ { deny all; return 403; }
```

> 最佳实践：将 `data/` 整个移到 Web 根目录之外，并在 `config.php` 中调整 `DATA_DIR` 常量。生产机上应将目录权限收紧为 `0700`、文件权限收紧为 `0600`，且仅允许 Web 服务进程用户读取。

---

## 9. 公众号接入（关键词自动回复 / 自动发卡）

用户关注公众号后，发送**与配置的关键词完全一致**的消息即触发回复；每条关键词可配置自己的回复文案（发卡或纯文案），每用户限领一张卡密。

### 回调地址

```
https://你的域名/wechat.php
```

在公众号后台「设置与开发 → 基本配置 → 服务器配置」填写：
- **URL**：上方回调地址
- **Token**：与 `data/wechat_config.json` 中的 `token` 一致
- **消息加解密方式**：明文 / 兼容 / 安全（见下表）

### 配置文件 `data/wechat_config.json`

```json
{
    "token":        "你的自定义Token",
    "appid":        "wx开头的AppID",
    "secret":       "AppSecret",
    "aes_key":      "安全模式下43字符EncodingAESKey（明文/兼容模式留空）",
    "encrypt_mode": "compatible",
    "no_match_reply":  "未识别的关键词",
    "keyword_rules": [
        { "keyword": "快手", "action": "issue", "reply": "恭喜领取成功！\\n卡密：{{card_key}}" },
        { "keyword": "帮助", "action": "text",  "reply": "回复「快手」即可领取一张卡密" }
    ],
    "reply_as_news": false,
    "reply_as_image": false,
    "reply_title": "卡密领取成功",
    "cover_url": "",
    "link_url": ""
}
```

| encrypt_mode | 说明 | aes_key |
|-------------|------|---------|
| `plain` | 收发均为明文 XML | 不需要 |
| `compatible` | 收发均为明文 XML，使用普通签名校验 | 不需要 |
| `safe` | 收发均为密文（AES-256-CBC） | **必须**填 43 字符 EncodingAESKey |

| 配置字段 | 说明 |
|----------|------|
| `token` | 微信服务器配置中的 Token，用于普通/兼容模式的签名校验。 |
| `appid` | 公众号 AppID；启用图片回复时用于取得 access token。 |
| `secret` | 公众号 AppSecret；仅保存在服务器，不会被后台接口返回。**图片回复**必填；**图文卡片**与**纯文本**不需要。 |
| `aes_key` | 安全模式的 43 字符 EncodingAESKey。 |
| `encrypt_mode` | `plain`、`compatible` 或 `safe`，必须与微信后台设置一致。 |
| `keyword_rules` | 关键词规则数组，每条含 `keyword`（关键词）、`action`（`issue` 发卡 / `text` 纯文案）、`reply`（回复文案模板）。**精确匹配**：用户消息须与 `keyword` 完全一致（不区分大小写）才触发。 |
| `no_match_reply` | 未命中任何关键词时的提示；**留空则静默不回复**（返回空 XML）。 |
| `reply_as_image` | `true` 时将命中规则的文案转为 SVG/PNG 图片回复。需 Imagick 扩展；上传失败自动降级为纯文本。 |
| `reply_as_news` | `true` 时发送**图文卡片**（原生微信 news 消息），无须 Imagick。优先级高于 `reply_as_image`。 |
| `reply_title` | 图文卡片标题模板，支持 `{{card_key}}`、`{{trigger_words}}`、`{{status_message}}`，默认 `卡密领取成功`。 |
| `cover_url` | 图文卡片封面图 URL（外网可访问）。留空时使用项目内置 `assets/cover.png`（按当前请求域名自动拼出）。 |
| `link_url` | 用户点击卡片时的跳转链接（可选）。 |
| `auto_reply_title` | 问答菜单标题。 |
| `auto_reply_options` | 问答菜单选项数组，每条 `{label, reply}`；用户回复**序号**或**标签文字**即回复对应内容。 |
| `menu_keyword` | 展示问答菜单的关键词，默认 `菜单`。 |

> 兼容旧版：若配置中只有 `trigger_words` / `reply_description`，会自动迁移为一条 `issue` 规则。
>
> 所有回调（GET 与 POST）都会校验微信签名；普通/兼容模式使用 `signature`，安全模式使用 `msg_signature`。配置缺失或仍为占位值（`replace_*`）时，`wechat.php` 返回 500，不会暴露任何数据。

### 行为

| 用户动作 | 系统响应 |
|----------|----------|
| 关注公众号（subscribe 事件） | 配置了问答菜单则展示菜单，否则回复内置默认欢迎文案 |
| 回复问答菜单的**序号**或**选项文字** | 回复该选项配置的内容 |
| 发送与某条卡密关键词**完全一致**的内容（不区分大小写） | 命中该条规则：`issue` 发放一张卡密并回复该规则文案；`text` 只回复文案 |
| 发送与某条**邀请码关键词**一致的内容 | 发放该网站的邀请码并回复「网站名 + 邀请码」 |
| 发送菜单关键词（默认 `菜单`） | 展示问答菜单 |
| 同一用户再次触发发卡/邀请码关键词 | 返回其已领取的同一张，不重复发放 |
| 未命中任何内容 | 回复 `no_match_reply`；留空则展示问答菜单；两者都未配置则静默 |

### 邀请码管理（接口 `invite.php`）

```
GET  invite.php?page=1&website=&status=   # 分页列表（需管理员）
POST invite.php                           # 导入邀请码 {website, keyword, codes}
POST invite.php?action=delete             # 删除 {ids: [...]}
POST invite.php?action=clear              # 按状态一键清理 {status: "unused|assigned|used|revoked"}
```

- 导入：`website` 网站名称（≤100 字符）、`keyword` 触发关键词（中文/字母/数字，≤30）、`codes` 每行一个邀请码（自动去重，重复跳过）。
- 用户发送该 `keyword` 时，公众号原子发放该网站的一张未使用邀请码（每用户每关键词一个）。
- 列表支持按网站模糊筛选与状态筛选，分页每页 20 条。

### 数据统计（接口 `stats.php`）

```
GET /stats.php   # 需管理员
```

返回：`card`（总数、各状态数量、按关键词卡密统计、最近 7 天核销趋势）与 `invite`（总数、**已发放** `issued`、**未发放** `unissued`、按网站统计）。后台登录后默认显示统计页。

> 邀请码口径：由第三方网站生成，本系统只负责发放，无法得知是否真正使用，故只统计「已发放（assigned+used）」与「未发放（unused）」。

### 发放规则（防薅）

- 每张卡密发放时标记为 `assigned`，并写入 `owner_openid = 用户openid`；该状态表示已发放但尚未核销，仍可验证和核销。
- 使用 `BEGIN IMMEDIATE` 事务 + 条件更新，**并发下仅一个请求成功认领**，且同一 `openid` 名下已有卡时直接返回原卡。
- 卡密耗尽时回复「活动卡密已发放完毕」；若全部过期则提示已无可用卡密。
- `card_keys` 表的 `owner_openid` 列和 `assigned` 状态由 `migrate()` 自动迁移；已有卡密及核销记录会保留。

### 上线注意

- 公众号**强制要求 HTTPS 且 443 端口**。本地 `php -S` 仅适合联调；正式环境需在 443 部署 Nginx/Apache 等反向代理。
- 部署方式与文件保护同 § 部署章节（必须带 `router.php`，否则 `data/` 可被下载）。
- 频率限制：同一 openid 0.5 秒内仅处理一次，防止刷消息。

### 关键词规则设置（后台可配置）

管理员可在后台「公众号接入 → 关键词回复」维护多条关键词规则（关键词 / 动作 / 回复文案），并支持套用预制 SVG 模板与实时预览。旧版 `trigger_words` 会自动迁移为发卡规则。

底层接口 `wechat_settings.php`（需管理员登录）：

```
GET  wechat_settings.php        # 读取当前设置
POST wechat_settings.php        # 更新关键词规则与回复设置
```

- **POST 关键词规则**：`keyword_rules` 为数组，每条 `{ "keyword": "...", "action": "issue|text", "reply": "..." }`。关键词仅限中文/字母/数字、最长 30 字符、不得重复；`reply` 最长 12000 字符；至少需要一条规则。
- **POST 文案**：`no_match_reply`（无匹配提示），最长 12000 字符。
- **POST 接口参数**：`token`（3-64 字符、无空白）、`appid`（可选，`wx` 开头）、`secret`（可选，留空保留原 Key）、`aes_key`（可选，43 字符）、`encrypt_mode`（`plain`/`compatible`/`safe`）。
- **POST 回复样式**：`reply_as_image` / `reply_as_news`（布尔）、`reply_title`（最长 200）、`cover_url` / `link_url`（`http://` 或 `https://` 开头）。
- GET 响应会返回 `keyword_rules`、`appid`、`secret_configured`、`aes_key_configured`、`encrypt_mode` 等，但**永不返回 `secret` / `aes_key` 的实际内容**。更新 AppSecret 后，后台输入框会清空，防止浏览器保存或泄漏密钥。
- 文案模板变量：`{{card_key}}`（发卡规则注入的卡密）、`{{trigger_words}}`（所有发卡关键词）、`{{status_message}}`（系统结果文字）。文案支持换行；以 `<svg` 开头时按 SVG 渲染图片/预览，宽高不得超过 2000px，禁止 DOCTYPE、脚本、事件属性、动画、`foreignObject` 及外部 URL。
- 启用 `reply_as_image` 时，服务器用 Imagick 将文案渲染为 PNG 并上传为微信临时素材后发送图片消息；渲染或上传失败自动降级为纯文本。
- 启用 `reply_as_news` 时发送**图文卡片**（`news` 消息），无需 Imagick，只需外网可访问的封面图 URL。优先级高于 `reply_as_image`。`cover_url` 留空时使用项目内置 `assets/cover.png`。
- 关键词**精确匹配**（不区分大小写）：用户消息与 `keyword` 完全一致才命中；包含但不等同不触发。未命中时按 `no_match_reply` 回复，留空则静默。
- 修改即时生效，无需重启；设置写入 `data/wechat_config.json`。

文章发布接口 `wechat_articles.php`：

- 所有请求必须为管理员 Session，并使用 `multipart/form-data`。
- `action=create_draft` 创建微信草稿，支持上传 JPG/PNG/GIF 封面或填写已有 `thumb_media_id`。
- `action=publish` 提交 `draft_media_id` 发布文章。发布前端会二次确认，微信发布后不可撤回。
- 封面最大 2MB；标题最长 64 字符；摘要最长 120 字符；正文最长 200000 字符。
- 需要配置 AppID、AppSecret，并且公众号拥有素材管理和群发接口权限。

### 文章发布接口 `wechat_articles.php`

所有请求必须为管理员 Session，并使用 `multipart/form-data`：

```text
POST /wechat_articles.php
action=create_draft
title=文章标题
author=作者
digest=文章摘要
content=<p>正文 HTML</p>
content_source_url=https://example.com/source
thumb_media_id=已有永久图片素材 ID
cover=@cover.jpg
```

- `create_draft`：使用已有 `thumb_media_id` 或上传 `cover`，调用微信草稿箱接口，返回文章 `media_id`。
- `publish`：提交 `draft_media_id` 到微信群发接口。发布前端会弹出二次确认，微信发布后不可撤回。
- 封面上传限制为 JPG/PNG/GIF，最大 2MB；标题最长 64 字符；摘要最长 120 字符；正文最长 200000 字符。
- 需要在后台配置 AppID/AppSecret，公众号还必须拥有素材管理和群发接口权限。

---

## 1. 初始化数据库

```
POST /init.php
```

首次部署时由已登录管理员调用，创建 `card_keys` 数据表及索引；后续调用会执行兼容迁移。无需传参。

**响应示例**

```json
{
    "success": true,
    "message": "数据库初始化成功"
}
```

---

## 2. 生成卡密

```
POST /generate.php
```

生成指定数量的卡密，写入数据库并返回。

**请求参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| quantity | int | 是 | 生成数量，范围 1-1000 |
| remark | string | 否 | 批次备注信息 |
| expires_at | datetime | 否 | 过期时间，格式 `YYYY-MM-DD HH:MM:SS`，留空表示永不过期。后台按「天/周/月/季/年/永久」选择后由前端换算为具体时间戳 |
| keyword | string | 否 | 关联的回复关键词。生成的卡密归属该关键词卡池，公众号触发该关键词时优先发放；同关键词卡耗尽后回退通用池 |

**请求示例（URL-encoded）**

```bash
curl -X POST http://localhost:8080/generate.php \
  -d "quantity=10" \
  -d "remark=VIP会员批次" \
  -d "expires_at=2026-12-31 23:59:59" \
  -d "keyword=快手"
```

**响应示例**

```json
{
    "success": true,
    "data": [
        "QT3Z-B85V-287U-9GCE",
        "6P7C-KY7Q-XE3F-BYNF",
        "PYWC-NCYE-FJ44-AN6D"
    ],
    "count": 3
}
```

**卡密格式**

- 长度 16 位，4-4-4-4 格式，示例：`QT3Z-B85V-287U-9GCE`
- 字符集排除易混淆字符：去掉 `0`、`O`、`1`、`I`
- 使用 `random_int()` 密码学安全随机生成

---

## 3. 验证卡密

```
POST /validate.php
```

验证一张卡密的有效性，返回完整状态信息。

**请求参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| key_code | string | 是 | 卡密字符串（不区分大小写，系统自动转大写） |

**请求示例**

```bash
curl -X POST http://localhost:8080/validate.php \
  -d "key_code=QT3Z-B85V-287U-9GCE"
```

**响应示例**

```json
{
    "success": true,
    "valid": true,
    "message": "卡密有效",
    "data": {
        "key_code": "QT3Z-B85V-287U-9GCE",
        "status": "unused",
        "status_text": "未使用",
        "created_at": "2026-08-03 03:38:00",
        "used_at": null,
        "expires_at": null,
        "remark": "VIP会员批次"
    }
}
```

**卡密不存在时**

```json
{
    "success": true,
    "valid": false,
    "message": "卡密不存在",
    "data": null
}
```

**状态字段说明**

| status 值 | status_text | 说明 |
|-----------|------------|------|
| unused | 未使用 | 尚未发放，有效 |
| assigned | 已发放 | 已绑定公众号用户，尚未核销，有效 |
| used | 已使用 | 已被核销 |
| expired | 已过期 | 超过过期时间自动标记 |
| revoked | 已作废 | 手动作废 |

> 注意：此接口只做查询，不会自动将卡密标记为已使用。如需核销，请使用 `redeem.php`（见下一节）。

## 3.1 App 启动激活

```
POST /activate.php
```

供发布 App 在启动时激活并核销卡密。此接口不需要管理员 Session 或 API Token，不返回卡密、备注、归属或核销记录；成功时会原子更新卡密为 `used`、写入 `used_at`，并仅返回 App 倒计时所需的到期 Unix 时间戳和服务器 Unix 时间戳。为防止枚举，同一 IP 连续 20 次失败后会锁定 10 分钟。

**请求参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| key_code | string | 是 | 16 位卡密，格式 `XXXX-XXXX-XXXX-XXXX` |

**成功响应**

```json
{
  "success": true,
  "activated": true,
  "redeemed": true,
  "message": "激活成功",
  "expires_at_unix": 1798761600,
  "server_time_unix": 1785715200
}
```

- `expires_at_unix`：到期 Unix 秒时间戳；`null` 表示永久有效。
- `server_time_unix`：服务端当前 Unix 秒时间戳。App 应以此校正本机时钟后每秒更新剩余时长。

**失败响应**

```json
{
  "success": true,
  "activated": false,
  "message": "卡密无效"
}
```

**其他响应**

- 卡密格式不符合 `XXXX-XXXX-XXXX-XXXX` → HTTP `400`，`{"success": true, "activated": false, "message": "卡密格式无效"}`
- 同一 IP 连续 20 次验证失败被锁定 → HTTP `429`（响应头带 `Retry-After`），`{"success": false, "activated": false, "message": "请求过于频繁，请稍后再试"}`

> 该接口会核销卡密，卡密后台会显示「已使用」。同一张卡仅能成功激活一次；重复请求返回 `activated:false` 与「卡密已使用」。App 不得调用 `redeem.php`，因为管理员 API Token 不能放进 APK。部署时必须同时上传 `activate.php` 与更新后的 `config.php`，并保持 HTTPS 可访问。

---

## 3.5 核销卡密（原子）

```
POST /redeem.php
```

将一张 `unused` 或 `assigned` 卡密标记为 `used` 并记录 `used_at`。采用 `BEGIN IMMEDIATE` 事务 + 条件更新，**并发下恰好一次成功**，杜绝重复核销。

**鉴权**：管理员 Session 或 API Token（同 `validate.php`）。

**请求参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| key_code | string | 是 | 卡密字符串（不区分大小写，系统自动转大写） |

**请求示例**

```bash
curl -X POST http://localhost:8080/redeem.php \
  -H "X-API-Token: <你的API_TOKEN>" \
  -d "key_code=QT3Z-B85V-287U-9GCE"
```

**核销成功**

```json
{
  "success": true,
  "redeemed": true,
  "message": "核销成功",
  "data": {
    "key_code": "QT3Z-B85V-287U-9GCE",
    "status": "used",
    "status_text": "已使用",
    "used_at": "2026-08-03 12:00:00",
    "expires_at": null,
    "remark": "VIP会员批次"
  }
}
```

**重复使用 / 已过期**

```json
{
  "success": true,
  "redeemed": false,
  "message": "卡密无法核销：已使用",
  "data": { "key_code": "...", "status": "used", "status_text": "已使用", "used_at": "..." }
}
```

> 过期卡密会被惰性标记为 `expired` 后拒绝核销；卡密不存在时 `redeemed:false` 且 `data:null`。

---

## 4. 列出卡密

```
GET /list.php?page=1&status=
```

分页查询卡密列表，支持按状态筛选。

**请求参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| page | int | 否 | 页码，默认 1 |
| status | string | 否 | 筛选状态，可选值：`unused`、`assigned`、`used`、`expired`、`revoked`，留空为全部 |

**请求示例**

```bash
curl "http://localhost:8080/list.php?page=1&status=unused"
```

**响应示例**

```json
{
    "success": true,
    "data": [
        {
            "id": 1,
            "key_code": "QT3Z-B85V-287U-9GCE",
            "status": "unused",
            "status_text": "未使用",
            "created_at": "2026-08-03 03:38:00",
            "used_at": null,
            "expires_at": null,
            "remark": "VIP会员批次",
            "keyword": "快手",
            "owner_openid": null
        }
    ],
    "pagination": {
        "page": 1,
        "page_size": 20,
        "total": 100,
        "total_pages": 5
    }
}
```

**分页字段说明**

| 字段 | 说明 |
|------|------|
| page | 当前页码 |
| page_size | 每页条数（固定 20） |
| total | 符合条件的总条数 |
| total_pages | 总页数 |

---

## 4.1 删除 / 清理卡密

```
POST /cards.php?action=delete   # 按 ID 删除
POST /cards.php?action=clear    # 按状态一键清理
```

需管理员 Session，请求体为 JSON。

**按 ID 删除**：`{ "ids": [1, 2, 3] }`

**按状态清理**：`{ "status": "used" }`，status 可选 `unused` / `assigned` / `used` / `expired` / `revoked`。

**响应示例**

```json
{ "success": true, "message": "已删除 3 张卡密" }
```

> ⚠️ **删除为永久移除**：删除后的卡密在 `validate.php` / `activate.php` / `redeem.php` 中均返回「卡密无效/不存在」。已发放给用户的卡被删后，用户将无法使用。清理「未使用/已发放」前请确认。

---

## 5. 管理员登录

```
POST /auth.php?action=login
```

管理员登录，使用 Session 维持登录状态。同一 IP 与用户名在 15 分钟内连续失败 5 次会锁定 15 分钟，接口返回 `429` 和 `Retry-After`。

**请求格式**

- `Content-Type: application/json`
- Body 为 JSON 对象

**请求参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| username | string | 是 | 用户名 |
| password | string | 是 | 密码 |

**请求示例**

```bash
curl -X POST http://localhost:8080/auth.php?action=login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<你的密码>"}'
```

**响应示例（成功）**

```json
{
    "success": true,
    "message": "登录成功"
}
```

**响应示例（失败）**

```json
{
    "success": false,
    "message": "用户名或密码错误"
}
```

---

## 6. 检查登录状态

```
GET /auth.php?action=check
```

检查当前 Session 是否处于登录状态。

**请求示例**

```bash
curl "http://localhost:8080/auth.php?action=check"
```

**已登录响应**

```json
{
    "success": true,
    "logged_in": true,
    "username": "admin"
}
```

**未登录响应**

```json
{
    "success": true,
    "logged_in": false,
    "username": null
}
```

---

## 7. 退出登录

```
POST /auth.php?action=logout
```

销毁当前 Session，退出登录。

**请求示例**

```bash
curl -X POST http://localhost:8080/auth.php?action=logout
```

**响应示例**

```json
{
    "success": true,
    "message": "已退出"
}
```

---

## 8. 修改管理员账号

```
POST /change_credentials.php
```

修改管理员用户名和密码，需要先登录，且需验证当前密码。

**请求格式**

- `Content-Type: application/json`
- Body 为 JSON 对象

**请求参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| current_password | string | 是 | 当前密码，用于验证身份 |
| new_username | string | 是 | 新用户名 |
| new_password | string | 是 | 新密码，至少 8 位，且不得与用户名相同 |

**请求示例**

```bash
curl -X POST http://localhost:8080/change_credentials.php \
  -H "Content-Type: application/json" \
  -d '{
    "current_password": "<当前密码>",
    "new_username": "newadmin",
    "new_password": "newpass456"
  }'
```

**响应示例（成功）**

```json
{
    "success": true,
    "message": "修改成功"
}
```

**响应示例（当前密码错误）**

```json
{
    "success": false,
    "message": "当前密码验证失败"
}
```

**响应示例（参数不合法）**

```json
{
    "success": false,
    "message": "新密码至少8位"
}
```

> 密码使用 `password_hash()` bcrypt 加密存储，不会明文保存。修改后请使用新凭据重新登录。

**忘记管理员密码？** 在服务器上重新生成哈希并写入：

```bash
php -r '$p="data/admin_config.json"; $c=json_decode(file_get_contents($p),true);
$c["password_hash"]=password_hash("新密码", PASSWORD_DEFAULT);
file_put_contents($p, json_encode($c, JSON_UNESCAPED_UNICODE|JSON_PRETTY_PRINT));
echo "已更新\n";'
```

**查看 / 重置 API Token：**

```bash
php -r '$p="data/admin_config.json"; $c=json_decode(file_get_contents($p),true);
$c["api_token"]??=bin2hex(random_bytes(32));
file_put_contents($p, json_encode($c, JSON_UNESCAPED_UNICODE|JSON_PRETTY_PRINT));
echo $c["api_token"], PHP_EOL;'
```

---

## 错误处理

所有接口统一错误格式：

```json
{
    "success": false,
    "message": "错误描述"
}
```

HTTP 状态码说明：

| 状态码 | 含义 |
|--------|------|
| 200 | 请求成功（业务失败如「卡密无效」也返回 200，以响应体中的 `valid`/`redeemed`/`activated` 判断） |
| 400 | 参数错误（必填项缺失、数值越界、格式无效等） |
| 401 | 未登录或 API Token 无效/未配置 |
| 403 | 权限不足（修改凭据时当前密码验证失败） |
| 405 | 请求方法不支持 |
| 409 | 并发重复核销（`redeem.php` 已被其他请求核销） |
| 429 | 登录/激活尝试次数过多，请按 `Retry-After` 后重试 |
| 500 | 服务器内部错误 |

---

## 文件清单

| 文件 | 说明 |
|------|------|
| `init.php` | 初始化数据库表结构 |
| `config.php` | 公共引导：路径常量、JSON 输出、会话、鉴权、PDO 连接 |
| `generate.php` | 生成卡密接口（需管理员） |
| `cards.php` | 卡密删除/按状态清理接口（需管理员） |
| `validate.php` | 验证卡密接口（Session 或 Token） |
| `redeem.php` | **核销卡密接口（原子，防并发重复核销）** |
| `list.php` | 卡密列表接口（需管理员） |
| `auth.php` | 登录/登出/状态检查接口 |
| `change_credentials.php` | 修改管理员账号接口（需管理员） |
| `invite.php` | 邀请码导入/列表/删除接口（需管理员） |
| `stats.php` | 数据统计接口（需管理员） |
| `router.php` | **php -S 专用路由，拦截敏感文件** |
| `.htaccess` | Apache 保护规则 |
| `data/admin_config.json` | 管理员凭据 + API Token，**禁止外泄** |
| `data/card_keys.db` | SQLite 数据库文件 |
| `data/.htaccess` | 拒绝一切 Web 访问 |
| `login_rate_limits` 数据表 | 登录失败限流状态，按 IP 与用户名组合计数 |
| `invite_codes` 数据表 | 邀请码（按网站导入，含触发关键词） |
| `index.html` | 前端管理页面（纯前端，含 Tailwind CSS + Lucide 图标） |
| `tailwindcss.js` | Tailwind CSS 运行时（本地） |
| `lucide.js` | Lucide 图标库（本地） |
