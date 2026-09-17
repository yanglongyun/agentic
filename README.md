# agentic

一个带浏览器的本地 Agent 客户端。保留现有 `ui/` 和 `server/`，Electron 负责启动本地服务、显示窗口和承载网页。

独立的一键安装基础版在 `AGENT` 仓库；这个仓库继续开发客户端。

官网和安装包下载：<https://agentic.iimos.ai>。提供 macOS Apple Silicon 公证包和 Windows x64 安装包。

## 桌面客户端

需要 Node.js 22.23.1 或更新版本。

```sh
npm ci
npm ci --prefix ui
npm run app                 # 构建 UI 并启动客户端
npm run app:pack            # 生成当前平台的应用目录
npm run app:dist            # 生成当前平台的安装包
npm run app:test            # 本地服务启动、登录、退出测试
```

产物在 `release/`。安装包携带 Electron、Node.js、现有后端和 `ui/dist`，使用时不需要另装 Node.js。桌面启动器通过原有登录接口建立本机会话，关闭客户端时关闭它启动的服务。

正式签名、公证、校验和上传步骤见 [桌面发布](dev/desktop-release.md)，官网源码与部署说明在 [site/](site/README.md)。

聊天右上角的“浏览器”打开右侧面板，沿用 agentic 的样式。顶部为标签栏和地址栏，其他工具收在菜单中。

- 标签：图标和加载状态、自动收窄、拖动排序、中键关闭、右键关闭其他／右侧、恢复关闭标签、拥挤时的全部标签列表。新链接紧邻来源标签。
- 导航：网址与搜索、前进后退、刷新／停止、页内查找、缩放、截图、打印、系统浏览器打开、开发者工具。
- 数据：新标签页展示书签和目录，支持编辑、移动和删除；浏览历史可搜索；下载显示实际进度，支持取消、显示文件、清除记录。
- 网站：独立浏览分区、原生登录弹窗、HTTP 认证、逐站点权限授权。浏览器设置可更换搜索引擎、下载目录、重置权限、清理缓存和网站登录状态。
- Chrome 导入：macOS 下手动选择资料，分别导入书签或 Cookie。导入登录状态需要勾选授权并点击导入，可能弹出系统钥匙串授权；不会自动读取，不保证所有网站能直接登录。

快捷键支持 `⌘/Ctrl+L/T/W/Shift+T/F/D/R/P`、`⌘/Ctrl + +/-/0`、`Ctrl+Tab` 和 `Ctrl+Shift+Tab`。网页获得焦点后同样有效。

拖动左侧栏右边缘或浏览器左边缘可以调整宽度，并在本机记住。左侧栏范围为 200–440px，聊天区和浏览器各至少保留 320px。标签排序、切换、收起面板或进入设置保留已加载网页；空白标签不创建网页进程；重启仅加载活动标签，其余按需加载。

Agent 可以通过 `browser` 工具控制网页。工具只接收 `summary` 和 `code`，在代码中选择标签、执行网页 JS、真实点击按键、输入和截图。用户接管正在操作的网页时，脚本停止。详细接口、示例和当前边界见 [浏览器工具](dev/browser-tool.md)。

macOS 还可以在「设置 → Mac 控制」中开启 `computer` 工具，读取原生界面、截图、点击、输入、滚动和拖拽。它同样只接收 `summary` 和 `code`，需要系统辅助功能和屏幕录制权限，`⌘⇧Esc` 停止并关闭控制。接口和边界见 [Mac 控制](dev/computer-tool.md)。从源码构建需要 Xcode Command Line Tools。

后端继续读取原来的 agentic 配置、数据库和图片。桌面资料单独放在系统应用数据目录的 `agentic-desktop/` 中；`AGENT_HOME` 可指定后端数据目录，`AGENT_DESKTOP_HOME` 可指定桌面资料目录。网页会话与聊天登录会话使用不同的存储分区。默认工作目录是用户目录，设置中的工作目录仍然优先。

## 目录

```text
desktop/                     Electron 启动壳与本机浏览器能力
  index.js                   启动服务、登录、创建窗口、退出清理
  server.js                  调用现有 server 入口，管理进程生命周期
  browser/                   标签通信、CDP 控制、下载、权限、HTTP 认证、Chrome 导入
  preload.cjs                向界面暴露少量桌面方法和事件
  start.js                   开发启动入口
  prepare.js                 为安装包准备 Node.js 运行环境
  release.js                 正式签名、公证、打包与验证
  checksums.js               生成安装包 SHA-256 清单
site/                        产品官网静态页面与 Cloudflare 部署示例
ui/                          界面源码
  src/
    browser/                 浏览器面板、标签状态、网页视图
  dist/                      UI 构建产物，由 server 托管
  package.json
  vite.config.ts             打包到 dist
server/
  index.js                   HTTP 入口，托管 ui/dist，/api 分发
  api/
    index.js                 按路径分发
    http.js                  HTTP JSON 读写
    chat/                    WS 订阅、发送、取消、保存确认
    auth/
      index.js               分发 login / logout / me
      authorize.js           接口鉴权
      login/index.js         登录
      logout/index.js        退出
      me/index.js            登录状态
    sessions/
      index.js               分发 HTTP 方法或进入 [id]
      get.js                 会话列表
      post.js                新建会话
      [id]/
        index.js             分发会话方法和下一级路径
        get.js               会话详情
        patch.js             修改标题
        delete.js            删除会话及其消息、压缩记录
        messages/
          index.js           分发 GET
          get.js             查询历史消息
        compactions/index.js 查询压缩记录
        images/              上传与读取本会话图片
        remote/              注册、查看、撤销远程房间
    config/
      index.js               分发 GET / PUT
      get.js                 查看配置
      put.js                 保存配置
    status/index.js          服务状态
    images/
      index.js               分发图片地址
      [name]/index.js        分发 GET / HEAD
      [name]/get.js          读取已保存的图片
  ai/
    index.js                 请求模型、解析流、重试
    images.js                请求前将本地图片地址转换为 data URL
  agent/
    index.js                 接收消息，执行模型 / 压缩 / 工具循环，向外发事件
    runner.js                接收工具调用，直接导入工具并执行、返回结果
    compact.js               生成上下文摘要
    tools.js                 shell / read / write / edit / browser 工具定义
    functions/
      shell.js               执行命令
      read.js                读取文本和图片
      write.js               写文件
      edit.js                精确替换
      browser.js             执行浏览器脚本
  browser/
    index.js                 管理脚本线程、转发桌面 IPC、截图落盘
    worker.js                执行 code，提供 browser / page 方法
  db.js                      SQLite 连接、DDL、初始化表
  images.js                  图片文件保存与读取
  config.js                  配置读写
  defaults.json              默认配置、提示词
  scripts/                   命令行、安装服务、打包、检查
  tests/                     行为测试
  dist/                      发布包（构建生成）
package.json                 开发命令
install.sh / install.ps1      一行安装入口
agent / agent.cmd            启动器
```

请求顺序例如：`server/index.js → api/index.js → sessions/index.js → [id]/index.js → messages/index.js → post.js`。每层消费一段路径，最后按 HTTP 方法进入处理文件。SQL 直接写在接口里，不封装查询、写入或事务方法。Agent 依次接收业务方准备的 instructions、messages、model，再接配置等参数，通过 `onEvent` 交付九种运行事件：`message`、`reasoning`、`function_call`、`function_call_output`、`retry`、`usage`、`compact`、`done`、`error`。SQL 保存由会话 API 负责，事件结构与发送顺序见 [dev/agent-events.md](./dev/agent-events.md)。

## 开发

需要 Node.js 22.23.1 或更新版本。

```sh
npm ci
npm ci --prefix ui
npm run ui:build
npm start
```

打开启动日志中的地址，使用日志中的访问令牌登录，在设置里填写模型地址、API Key、模型名。模型地址为支持 Responses 消息格式的完整 HTTP 地址。

开发界面：另开终端运行 `npm run ui:dev`，Vite 代理 `/api` 到本机 9528 端口。改后端可用 `npm run dev`。

```sh
npm run format              # 统一格式化源码
npm run format:check        # 检查格式
npm run check
npm test
npm run build               # 构建 UI，打包当前机器的 Node.js
node server/scripts/smoke-install.js
```

## 数据库与压缩

数据文件是 `chat.db`，DDL 统一放在 `server/db.js`，服务启动时建表：

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  item TEXT,
  usage TEXT,
  created_at INTEGER
);
CREATE TABLE compactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  through_id INTEGER,
  summary TEXT,
  created_at INTEGER
);
CREATE INDEX idx_messages_session ON messages(session_id, id);
CREATE INDEX idx_compactions_session ON compactions(session_id, id);
```

`item` 是 JSON 字符串，时间是毫秒时间戳。没有 FOREIGN KEY、CHECK 或其他业务表。

- `messages.usage` 保存模型返回的原始 usage JSON，每次响应只放在最后一条模型输出上。用户消息和工具结果为 NULL；模型没有返回 usage 也存 NULL。
- 每次请求模型之前，用上次响应的 `usage.total_tokens` 与 `compact_at` 比较（大于等于时压缩）。用户发消息时从数据库读最近模型输出的 usage；工具执行后继续循环时使用本次模型返回的 usage。不累加历史 usage，不估算 token。
- usage 反映上次响应的实际用量，不包含后来新增的用户输入和工具结果。没有有效用量就跳过判断，不回退到更早的 usage。
- 压缩先发 compact.started，成功后通过 compact.completed 交付标准 user 摘要和数组覆盖范围；API 先保存摘要，再让 Agent 继续。压缩失败会终止本次运行。最终回答结束后不立即压缩，等下次请求模型前判断。
- 每次压缩追加一条记录，summary 保存标准 user 摘要块的完整文字，`through_id` 表示已总结到哪条消息（包含该条）。
- 下一次请求加载**最新摘要 + id 大于 through_id 的消息**。
- 后续压缩包含上次摘要，原始消息始终保留，可以翻看。
- 压缩按完整工具调用边界截断，至少保留 `keep` 条最近消息；没有合适边界或待压缩范围只有一个块就跳过。
- 用户消息立即保存；每轮模型输出和对应工具全部完成后一起保存。失败或取消只丢弃当前未完成轮次，之前完成的工具轮次及已入库摘要保留。已执行的命令和文件修改仍然有效。

开发阶段只使用当前表结构。数据库入口只执行建表，不包含升级、迁移或旧结构处理。

图片保存在数据目录的 `images/` 下。图片工具结果使用标准 `function_call_output.output` 数组，数据库和事件中的 `input_image.image_url` 只保存 `/api/images/文件名`，不保存 Base64。AI 请求入口读取图片文件，仅在本次请求中替换为 data URL；原始消息不变。前端通过带登录鉴权的图片接口显示工具图片。业务层通过运行配置 `images_dir` 指定图片目录。

## 接口

接口使用登录 Cookie 或 `Authorization: Bearer <访问令牌>`。

| 方法                 | 路径                                             | 用途                                 |
| -------------------- | ------------------------------------------------ | ------------------------------------ |
| POST                 | `/api/auth/login`                                | `{ token }` 登录                     |
| POST                 | `/api/auth/logout`                               | 退出                                 |
| GET                  | `/api/auth/me`                                   | 登录状态                             |
| GET                  | `/api/status`                                    | 模型配置状态、版本、工作目录         |
| GET / PUT            | `/api/config`                                    | 查看 / 保存配置                      |
| GET / HEAD           | `/api/images/:name`                              | 查看已保存的图片                     |
| GET / POST           | `/api/sessions`                                  | 列表 / 新建 `{ title? }`             |
| GET / PATCH / DELETE | `/api/sessions/:id`                              | 查看 / 改名 `{ title }` / 删除       |
| GET                  | `/api/sessions/:id/messages?before=123&limit=60` | 历史消息                             |
| WS                   | `/api/chat`                                      | 订阅、发送、取消、运行事件和保存确认 |
| POST                 | `/api/sessions/:id/images`                       | 单张图片上传                         |
| GET                  | `/api/sessions/:id/images/:name`                 | 读取本会话图片                       |
| GET / POST / DELETE  | `/api/sessions/:id/remote`                       | 查看、开启、关闭远程访问             |
| GET                  | `/api/sessions/:id/compactions`                  | 压缩记录                             |
| GET                  | `/healthz`                                       | 服务存活检查                         |

Agent 的九种事件位于 WS 业务消息的 `run.event.event` 内。业务层另行发送订阅快照、请求确认、消息保存、摘要保存、会话状态和运行结束等消息，完整协议见 [dev/chat-protocol.md](dev/chat-protocol.md)。

每个会话同时只运行一轮，不同会话可并行。关闭页面、切换会话或断开 WS 不停止执行；点击停止才发送 cancel。重连后订阅快照恢复已保存消息和实时增量。发送请求使用持久化 request_id 去重，断线重发不会重复执行。

数据库提交后通过 messages.saved 和 compaction.created 直接更新前端，回复完成不重新请求消息或列表。

远程中转实现位于 [relay/worker](relay/worker/README.md)。部署 Worker 后，在会话右上角「远程」创建访问链接。远程仅能操作指定会话，本地客户端需保持运行。

输入框支持选择或粘贴图片，发送前可预览和移除，也可只发送图片。每条消息最多 5 张，支持 PNG、JPEG、GIF、WebP，单张不超过 10 MiB。图片存放在数据目录 images/，消息只保存本地图片地址；模型请求时读取文件，构造标准 input_image。删除会话时一并删除图片。

## 服务器一行安装

**先将此版本发布到仓库的 Releases**，下面的命令才会安装这次重构的版本：

```sh
curl -fsSL https://raw.githubusercontent.com/yanglongyun/agentic/main/install.sh | sh
```

Linux 有 systemd 时，安装脚本会启动服务并设置开机启动。发布包包含 Node.js、后端代码和构建后的 UI，服务器无需安装 npm 或编译前端。

```sh
agent token
agent status
agent restart
agent stop
agent start
agent uninstall             # 卸载服务，保留数据
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/yanglongyun/agentic/main/install.ps1 | iex
agent serve
```

本地生成指定平台发布包：

```sh
npm run ui:build
npm run release:pack -- --platform linux --arch amd64
```

平台支持 `linux / darwin / windows`，架构支持 `amd64 / arm64`。打包器下载并校验固定版本 Node.js，产物位于 `server/dist/`。安装时校验 SHA-256；`AGENT_RELEASE_BASE_URL` 可指定私有发布镜像，`AGENT_NO_SERVICE=1` 可只安装不启动。

数据默认放在 Linux `~/.config/agentic`、macOS `~/Library/Application Support/agentic`、Windows `%APPDATA%/agentic`。可用 `AGENT_HOME` 指定目录。该目录包含 `config.json`、`chat.db` 及 SQLite 日志文件。

### 验证代码

```sh
npm run check
npm test
npm run ui:test
npm run ui:build
npm run format:check
```

配置文件只接受当前字段，缺失、未知或无效字段会直接报错。模型上下文窗口非零时，压缩阈值必须小于窗口；实际压缩只使用模型返回的 total_tokens。整轮回复超时由 run_timeout 控制，AI 请求不另设隐藏时限。

### 页面路由

前端使用 React Router，页面入口定义在 `ui/src/router.tsx`。

| URL             | 页面     |
| --------------- | -------- |
| `/`             | 新对话   |
| `/sessions/:id` | 指定会话 |
| `/settings`     | 设置     |
| `/login`        | 登录     |

URL 决定当前页面和会话。支持直接打开、刷新、前进后退；新会话创建后用会话 URL 替换新对话入口。未登录时先进入登录页，登录成功后回到原页面。服务器只为这些页面路径返回 `ui/dist/index.html`，未知资源和 API 保持各自的错误响应。
