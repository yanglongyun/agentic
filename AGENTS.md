# agentic 开发约定

- 三部分：`app/` Tauri + Rust 本机执行客户端，`extension/` 浏览器插件，`worker/` Cloudflare Worker + Vue 网页。
- 本机执行不依赖 Node / Electron。UI、模型调用、会话在 Worker。远程网页没有 Tauri IPC 权限。
- 本地设置通过 IPC，设备令牌存 macOS 钥匙串。设备通道复用 Worker 的鉴权与消息协议。
- 插件宿主 `ai.agentic.browser`，插件 ID 与 manifest key 保持一致。
- 不提交配置、令牌、API Key、签名或公证凭据。不要修改 Roam 源项目。
- 修改 Rust：cargo fmt、npm test、cargo check；修改网页：npm run build:ui。交付前 Worker 联调和 Mac 打包验证。
