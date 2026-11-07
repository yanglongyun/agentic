# agentic

一个由 **Tauri + Rust 客户端、浏览器插件、Cloudflare Worker** 组成的 AI 产品。打开 Mac App 加载云端网页，后台以一台设备的身份提供本机能力；也可以从手机或任意浏览器操作已连接的电脑。

基于 Roam 最新提交 `b62132d`（此前为 `dd30fb0`）同步，agentic 版本为 0.3.0。新增独立助理 / 任务应用、主动汇报、用量统计和会话提示词；设备绑定在任务上。

## 结构

- `app/src-tauri/`：Rust 本机执行端与 Tauri 桌面壳。负责设备鉴权、WebSocket、终端 PTY、命令执行、文件、截图、状态和浏览器桥接。
- `app/ui/`：仅用于首次连接与修改服务的本地设置页。设备令牌保存到 macOS 钥匙串，普通配置保存在用户目录。
- `extension/`：Chrome / Edge 插件。通过 Native Messaging 与 Rust 通信；不依赖 Node。
- `worker/`：Cloudflare Worker + Durable Object + D1 + Vue 网页。负责界面、模型调用、会话、设备管理与消息路由；图片功能可选 R2。

```text
Tauri 窗口 / 手机浏览器 → Worker（网页、AI、D1、可选 R2）
                           ↕ 设备令牌 + WebSocket
                       Rust 执行端 ↔ 浏览器插件
```

功能与 Roam 对齐：多设备、AI 对话、交互终端、文件浏览与上传、屏幕截图、系统状态及浏览器操作。Rust 执行端支持网页屏幕会话与任务 computer 工具共用的串行队列、画面归属与过期校验、输入后的截图失效以及 tool.cancel。截图与控制须在本机授权。远程网页没有 Tauri IPC 权限；只有本地设置窗口能够修改连接。只连接自己信任的 Worker，因为它能下发本机命令和文件操作。

## 本机开发与打包

需要 Node.js 22+（仅开发网页与工具）、Rust stable、Apple 命令行开发工具。最终 App 不需要用户安装 Node、Rust 或 Electron。

```sh
npm run setup
npm run app
npm test
npm run build:ui
npm run pack:mac
npm run build:app
```

`pack:mac` 构建 `.app`；`build:app` 构建 `.app` 与 `.dmg`。产物在 `app/src-tauri/target/release/bundle/`。公开发布前需要 Developer ID 签名和 Apple 公证；本地包与公开发布分开验证。

Rust 检查：

```sh
cargo fmt --manifest-path app/src-tauri/Cargo.toml --check
cargo check --manifest-path app/src-tauri/Cargo.toml
```

首次打开 App，填写服务地址、设备令牌、设备名与描述。连接后在网页输入访问密码。关闭窗口后驻留菜单栏，退出 App 停止本机执行能力。修改连接时重启设备通道。上传采用临时文件，完整接收后再提交，失败时保留原文件。

客户端配置与设备 ID 在 `~/Library/Application Support/ai.agentic-client/`，可通过 `AGENTIC_HOME` 指定独立开发目录。设备令牌在 macOS 钥匙串，连接 JSON 不包含令牌。与旧 agentic 和 Roam 的设备数据隔离。

浏览器插件：从菜单栏打开插件文件夹，在 Chrome / Edge 扩展管理页启用开发者模式，加载这个文件夹。插件宿主为 `ai.agentic.browser`，与 Roam 独立。Chrome 启动的是同一个 Rust 二进制的 `--native-host` 模式。

截图首次使用时，需要在系统设置的隐私与安全性中允许 agentic 录制屏幕。

## Worker 部署

生产服务：https://agentic.yanglong.yun。使用 Cloudflare `cf` CLI；需要 Node.js 22.23+。

- `worker/cloudflare.config.ts`：域名、Worker、D1、Durable Object、R2 和 Secret 声明。
- `worker/wrangler.config.ts`：静态资源构建配置。
- `worker/wrangler.local.jsonc`：隔离的本地联调配置。

```sh
cf auth login --use-keyring
cd worker
npm run deploy
```

部署脚本先编译 Vue 和 Worker Build Output，再用 `cf deploy --prebuilt` 发布。首次发布通过 `--secrets-file` 注入 SETTINGS_KEY、DEVICE_TOKEN、ACCESS_PASSWORD；后续发布保留已有 Secret。SETTINGS_KEY 用于加密模型 Key，不应随意更换。

生产资源为独立的 agentic D1、Durable Object 和私有 R2，不共用 Roam 数据。客户端连接信息在本机私密文件中交付，任何凭据都不提交 Git。

## 本地联调

```sh
npm run build:ui
cd worker
npx wrangler d1 execute agentic --local --config wrangler.local.jsonc --file server/agent/schema.sql
npx wrangler dev --config wrangler.local.jsonc --port 9507 --var SETTINGS_KEY:dev --var DEVICE_TOKEN:e2e-token --var ACCESS_PASSWORD:e2e-pass
# 另一个终端，在 worker 下：
node tests/e2e.mjs
# 有真实 Rust 执行端接入时，再运行：
PORT=9507 node tests/native-device.mjs
# 最后运行锁定测试：
node tests/extra.mjs
```

客户端填 `http://127.0.0.1:9507`、设备令牌 `e2e-token`。extra 测试最后触发密码锁定，只使用独立测试数据库。

Rust 执行端可独立运行，用于联调或无界面服务（不会保存环境变量中的令牌）：

```sh
CLOUDFLARE_WORKER_URL=http://127.0.0.1:9507 DEVICE_TOKEN=e2e-token cargo run --manifest-path app/src-tauri/Cargo.toml --no-default-features -- --headless
```

## 来源与许可

沿用同一作者 Roam 的 Vue UI、Worker 和设备消息协议；本机执行端改用 Rust。旧版 agentic 的本地 AI 与自修改工作区不再作为新产品入口。MIT，见 LICENSE。

本轮部署前为 D1 保存了恢复书签，使用增量 SQL 增加缺失列和任务 / 通知表；旧会话与模型配置保留。
