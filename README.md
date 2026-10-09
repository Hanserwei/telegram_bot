# Telegram 图文视频发布机器人 · Cloudflare 版

已支持多图、多视频和混合相册，操作说明见 [MULTIMEDIA.md](MULTIMEDIA.md)。

**不需要物理服务器，也不需要先购买域名。** 后台部署在 Cloudflare Workers，视频保存在 Telegram 私有频道，观看页使用 Telegraph。

你发视频给机器人 → 填文案 → 选择展示频道 → 预览并确认发布 → 频道出现文案和蓝色链接 → 用户打开 Telegraph 页面播放这一条视频。

## 第一版功能

- 仅配置的管理员能操作机器人，且只能管理自己上传的草稿。
- 支持图片（Telegram 照片或 JPG/PNG/WebP/GIF 文件）和 MP4 视频，每个文件最多 **10 MiB**，每篇最多 **20 个素材**。视频推荐 H.264/AAC。
- 同一相册自动合并为一份草稿；回复草稿可追加素材或修改文案。相册收齐后点击「生成预览」，再确认发布。
- 支持配置多个展示频道；**每条草稿选择一个频道**，默认选配置中的第一个。发布按钮明确显示目标频道。
- 频道内容为：原文案、`▶️ 点击观看`、Telegraph 蓝色链接。频道和机器人草稿均关闭链接预览，不提前展示页面图片或视频。
- 每份草稿一个 Telegraph 页面，按发送顺序展示该草稿的全部图片和视频，不包含存档频道入口或其他草稿内容。
- Webhook 更新去重、发布按钮去重、旧预览失效检查；发送结果不明确时停止自动重发。
- 视频中转支持 `HEAD`、单段 `Range`、拖动进度、跨域；上游不支持 Range 时使用流式截取，不将整个视频读入内存。
- `/drafts` 找回最近草稿；`/check` 检查频道权限。

目前不包含定时发布、付费观看、发布后的文案同步修改或视频转码。文案按纯文本发布，不保留 Telegram 富文本样式。用户仍需按客户端行为点击播放，不保证打开页面即自动播放，也不保证所有客户端均展示 Instant View。

## 架构与 Pages 的区别

```text
管理员的 Telegram
      │ 视频 / 文案 / 确认按钮
      ▼
Workers Webhook ──► Cloudflare Queue ──► 机器人处理逻辑
                                         ├── 私有 Telegram 频道：存档视频
                                         ├── Cloudflare D1：草稿、关联关系、发布状态
                                         ├── Telegraph：独立观看页
                                         └── 展示频道：文案 + 观看链接

用户 ──► Telegraph 页面 ──► Workers /media/随机标识.mp4 ──► Telegram 视频
```

Pages 可以借助 Pages Functions 运行部分后端，但这里没有需要托管的静态网站，并且需要消费消息队列。因此使用 **Workers + D1 + Queues** 更直接。项目不依赖 VPS、常驻 Python 进程、R2 或本地磁盘。

队列将 Telegram 的快速 Webhook 确认与后续网络请求分开。`max_concurrency: 1` 用来串行处理管理操作，**不要随意调大**。D1 的条件更新进一步防止重复发布。

Telegraph 只存页面，图片和视频通过自己的 Worker 地址加载。没有使用 Telegraph 旧的 `/upload` 接口，因此不依赖其过去的 5 MB 上传限制。

## 部署前准备

1. 一个 Cloudflare 账户，本机安装 Node.js 22 或以上。
2. 在 Telegram 的 `@BotFather` 创建机器人，取得 Bot Token。
3. 一个**私有存档频道**和至少一个展示频道，将机器人加入两者并设为管理员，授予「发布消息」权限。
4. 一个可供用户、Telegraph 和 Telegram 访问的 HTTPS 地址。可先使用 Cloudflare 提供的 `https://telegram-video-publisher.你的子域.workers.dev`，不需要购买域名。

### 1. 安装依赖，填写本机配置

```bash
npm ci
cp .dev.vars.example .dev.vars
```

先把 Bot Token 填入 `.dev.vars`。此文件已在 `.gitignore` 中排除；不要提交或转发它。

运行 ID 辅助工具：

```bash
npm run setup:ids
```

- 给机器人发一条私聊消息，终端显示你的用户 ID。
- 将机器人加为频道管理员后，在对应频道发一条消息，终端显示频道 ID。
- 也可以转发频道消息给机器人，终端会显示其来源频道 ID。
- 工具只在本机打印 ID，不向任何人回复消息。记下 ID 后按 `Ctrl+C` 停止。
- 此工具采用临时长轮询，不能和已注册的 Webhook 同时运行。如果已有部署，请优先使用现有配置中的 ID。
- 偶发网络断开、超时或 Telegram 服务故障会自动重试，不会丢失已经获取的 ID。持续失败时检查本机到 Telegram 的网络连接。
- 若提示 `409`，关闭其他使用同一机器人的 ID 工具或长轮询进程；若提示 `401`，检查 Token 是否被撤销或填写错误。
- npm 的 `Unknown user config "onnxruntime-node-install-cuda"` 是本机 npm 配置警告，与 Telegram 请求失败无关，不影响此工具运行。

### 2. 创建 Cloudflare 资源

```bash
npx wrangler login
npx wrangler d1 create telegram-video-publisher
npx wrangler queues create telegram-video-updates
```

将返回的数据库 ID 填到 `wrangler.jsonc` 的 `database_id`，替换全零占位值。
如果 Wrangler 自动追加了 `telegram_video_publisher` 绑定，请将它合并到原有的 `DB` 配置中；代码使用的是 `DB`，同一数据库不需要配置两份绑定。

在 Cloudflare 控制台 **Workers & Pages** 中确认自己的 `workers.dev` 子域名。更新 `wrangler.jsonc` 的 `vars`：

| 配置 | 含义 |
| --- | --- |
| `ADMIN_IDS` | 用户 ID 的 JSON 数组，例如 `[123456789]` |
| `ARCHIVE_CHAT_ID` | 私有存档频道的负数 ID，通常以 `-100` 开头 |
| `PUBLISH_CHANNELS` | 名称到频道 ID 的 JSON 对象，例如 `{"教程":-1001111111111,"资讯":-1002222222222}` |
| `PUBLIC_BASE_URL` | 完整公网 HTTPS 地址，不带路径，例如 `https://telegram-video-publisher.example.workers.dev` |
| `TELEGRAPH_AUTHOR_NAME` | Telegraph 页面显示的作者名 |

**将这些值同步到 `.dev.vars`。** `wrangler.jsonc` 的 `vars` 是线上配置；`.dev.vars` 用于本地工具和本地调试，不会随 Worker 上传。

### 3. 设置密钥、迁移数据库、部署

生成 Webhook 密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

把它填入 `.dev.vars` 的 `WEBHOOK_SECRET`，并通过交互式提示写入线上密钥：

```bash
npm run db:remote
npm run deploy
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
```

两个线上密钥必须与 `.dev.vars` 中的值一致。先部署创建 Worker，再设置密钥；全部配置完成后再注册 Webhook。

可选：如果已经有自己的 Telegraph API Access Token，可用 `npx wrangler secret put TELEGRAPH_ACCESS_TOKEN` 设置。没有则省略，首次生成页面时会自动创建账户，令牌保存在 D1 的 `settings` 表中。

### 4. 注册 Telegram Webhook

确认部署返回的 URL 与 `PUBLIC_BASE_URL` 相同。地址有变化时，先同步更新两个配置文件并重新部署。

```bash
npm run setup:webhook
npm run setup:check
```

注册脚本先检查 `/healthz`，再设置 Webhook 密钥、接收更新类型和机器人命令菜单。不会清空 Telegram 待处理更新。`setup:check` 检查部署、Webhook 和频道权限。
`setup:check` 还会使用 Webhook 密钥调用只读诊断接口，验证 **Cloudflare 运行环境本身**能否连接 Telegram API；仅本机 API 成功不代表线上机器人能够发起请求。该检查不会发送消息。

### 5. 用真实视频验收

1. 私聊机器人发送 `/check`，确认私有存档频道和展示频道均可发布。
2. 上传一个 10 MB 以内的 MP4，暂不附文案。
3. 回复机器人返回的草稿消息，填写测试文案。
4. 在预览里选择正确频道，检查文案与视频对应，点击「确认发布」。
5. 用普通用户账号打开频道里的 Telegraph 链接，播放并拖动进度。无需启动机器人或加入存档频道。
6. 确认页面没有其他视频列表；重复点击同一草稿的发布按钮不会产生第二条频道消息。

**本项目的自动测试模拟 Telegram 和 Telegraph 请求，无法代替这一步真实播放验收。** 如果你的网络无法访问默认的 `workers.dev` 地址，需要给 Worker 绑定用户可访问的自定义域名，再更新 `PUBLIC_BASE_URL`。请在正式批量发布前确定稳定地址；旧 Telegraph 页不会自动迁移到新域名。

## 日常使用

- **单个素材和文案一起发**：生成草稿和预览，确认后发布。
- **多图、多视频或混合相册**：一次多选发送，核对已收到的素材数量后点击「生成预览」。
- **追加素材**：回复已有草稿发送新素材或另一组相册，然后重新预览。
- **先发视频**：回复对应视频或机器人草稿消息补文案。直接发送未关联的文字会提示你先回复某条消息，不会随意绑定最近的视频。
- **修改文案**：回复该草稿的预览消息，新文案覆盖旧文案，再检查最新预览。
- **选择频道**：每份草稿独立选择目标，不改变其他草稿。使用最新预览上的发布按钮。
- **取消草稿**：仅发布前可取消。保留存档视频，停用该视频的媒体地址。整组素材的访问地址会一起停用，已下载或浏览器已缓存的内容不会被远程删除。
- **找回草稿**：`/drafts` 列出最近 10 条；`/draft 草稿编号` 可打开已有草稿。

### 网络中断后的发布恢复

Telegram 的 `sendMessage` 没有业务幂等键。遇到超时，无法可靠判断帖子是否已经发出，因此不会自动重发。

如果草稿显示「发送结果待核实」，先检查目标频道：

```text
已发出：/resolve 草稿编号 sent 消息编号
未发出：/resolve 草稿编号 retry
```

消息编号是频道消息链接末尾的数字。`retry` 只将草稿恢复为待发布并重新预览，仍然需要点击确认。意外终止时卡在「正在发布」的草稿，超过两分钟后可以通过 `/drafts` 或 `/draft` 刷新；定时维护也会每十分钟自动将其改为待核实。

## 运维与边界

- 视频长期保存在 Telegram；D1 存索引和 Telegraph 账户令牌，需要保留。不要删除数据库或随意换成另一只机器人。
- 备份数据库：`npx wrangler d1 export DB --remote --output backup.sql`。备份包含账户凭据和视频索引，妥善保存，勿提交仓库。
- Worker 逐段传输视频，不进行转码，也不把原始 Bot Token、Telegram 文件地址或频道 ID发给观看者。浏览器允许短时缓存五分钟，Worker 本身不永久存储视频。
- 每个媒体地址使用 256 位随机标识，没有视频列表接口。**它是持有链接即可访问，不是账号权限控制**；别人仍可转发链接或下载视频。
- Telegraph 页面在预览时就已生成，但只有你拿到链接；不是必须发布到展示频道后才开放访问。
- 页面能打开不代表视频源一定可用；可用性同时依赖 Telegram、Telegraph、Workers 和观看者网络。
- 不默认开启请求日志，避免将可访问视频的完整地址长期写入日志。
- `/healthz` 仅检查 Worker 和 D1，不代表视频、频道权限或 Telegram Webhook 全链路正常。
- 修改 `wrangler.jsonc` 后运行 `npm run deploy`。普通代码更新无需重新注册 Webhook；更改域名或 Webhook 密钥后需要重新注册。

## 套餐与容量

截至 2026-10-09 核对的官方文档：Workers Free 每日 100,000 次请求、每次 10 ms CPU 时间；D1 Free 提供 5 GB 账户存储额度；Queues Free 每日 10,000 次标准操作，通常一条队列消息需要写入、读取、删除三次操作。

目前这种少量、10 MB 以内视频可先用免费套餐试运行，**不承诺永久免费或不限量**。播放拖动可能产生多个请求，流式截取也会使用 CPU；实际以控制台用量与当时套餐规则为准。

- [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers 价格](https://developers.cloudflare.com/workers/platform/pricing/)
- [D1 限制](https://developers.cloudflare.com/d1/platform/limits/)
- [Queues 价格](https://developers.cloudflare.com/queues/platform/pricing/)
- [Telegraph API](https://telegra.ph/api)

## 本地开发与验证

```bash
npm ci
npm run check
npm test
npm run db:local
npm run dev
```

本地 Webhook 不会自动连接 Telegram。需要一个可达的 HTTPS 测试地址，且不要把生产 Webhook 指向短期测试地址。单纯运行测试不会向 Telegram 发消息、创建 Telegraph 页面或部署 Cloudflare 资源。

可用 `npx wrangler deploy --dry-run` 检查部署打包，无需上线。
