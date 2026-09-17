# 会话远程中转

一个 Cloudflare Worker + Durable Object 房间，对应本地客户端中的一个会话。Worker 托管同一份 `ui/dist`，转发聊天 WS 和有限的图片/历史 HTTP 请求。模型、工具、消息和图片留在本地客户端。

## 部署

在项目根目录执行：

```bash
npm ci
npm --prefix ui ci
npm run ui:build
npm --prefix relay/worker ci
cd relay/worker
cp wrangler.example.jsonc wrangler.jsonc
# 编辑 wrangler.jsonc：填写 account_id 和 routes 中的域名
npx wrangler login
npm run deploy
npx wrangler secret put RELAY_SECRET
```

实际 `wrangler.jsonc`、`.secrets.json` 和 `.dev.vars` 已被 Git 忽略。仓库只保存 `wrangler.example.jsonc`，其中账号和域名是占位值。首次部署前必须复制示例并填写实际配置。

RELAY_SECRET 输入自己生成的至少 24 位随机密钥，例如使用 `openssl rand -hex 32` 生成。它是创建房间的管理密钥。Cloudflare 账户和部署地址由你自己的账号决定。

部署后，在本地客户端打开一个会话，点击右上角「远程」，填写 Worker 地址和管理密钥，开启后复制访问链接。在另一台设备打开链接即可查看和继续此会话。本地客户端必须保持运行、联网；电脑休眠期间远程页面会显示等待连接。

关闭远程访问会撤销房间、关闭访问者连接，旧链接随即失效。再次开启会生成新的房间和链接。授权链接允许运行此会话的工具，应只交给可信的人。

## 本地测试

先构建 UI，然后启动 Worker：

```bash
npm run ui:build
cd relay/worker
# 首次使用先复制配置示例，随后本地开发不需要填写真实账号
cp -n wrangler.example.jsonc wrangler.jsonc
npm run dev -- --port 8787 --var RELAY_SECRET:local-test-relay-secret-12345678
```

客户端「远程」填写 `http://127.0.0.1:8787` 和上面的测试密钥。本地 HTTP 仅用于测试，线上地址必须是 HTTPS。

另一个终端运行：

```bash
npm --prefix relay/worker test
```

测试会新建临时数据库和模拟模型，验证双端消息、会话隔离、分块图片传输、客户端重启重连和撤销。测试默认访问 127.0.0.1:8787，可通过 RELAY_TEST_URL、RELAY_TEST_SECRET 覆盖。

```bash
npm --prefix relay/worker run check
```

此命令执行部署 dry-run，只检查打包，不发布到 Cloudflare。

## 文件

```text
relay/worker/
  src/index.js       HTTP 路径分发、房间注册、UI 静态托管
  src/room.js        一个会话的连接、授权、HTTP 转发
  wrangler.example.jsonc  可提交的配置示例
  wrangler.jsonc          本机实际部署配置（Git 忽略）
  integration.test.js
```

房间使用 WebSocket Hibernation API，空闲时可休眠；心跳使用自动响应。`exports` 直接声明 SQLite Durable Object 类，无旧结构兼容和数据迁移逻辑。参考 [Cloudflare WebSocket 文档](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) 和 [类声明说明](https://developers.cloudflare.com/durable-objects/release-notes/)。

HTTP 上传按 48 KiB 分块经 WS 转发，请求上限 14 MiB、响应上限 20 MiB、超时 30 秒，每房间最多 4 个并行 HTTP 请求和 8 个远程连接。图片本身单张上限 10 MiB，每条聊天最多 5 张。

Worker 只保存房间凭据哈希和撤销状态，不保存聊天历史或图片；传输内容经过 Worker，不是端到端加密。协议见 [dev/chat-protocol.md](../../dev/chat-protocol.md)。
