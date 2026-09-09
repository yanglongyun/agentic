# 代码目录说明

本项目是 Go 单程序，借鉴 AGENT 项目的职责分层。`cmd` 是入口，`internal` 是程序内部代码。
源码目录与运行时 `config.json`、`state.json`、`sessions/` 数据目录是两回事。

```text
agentic/
├── cmd/agent/main.go        程序入口，调用 cli.Run
├── internal/
│   ├── cli/                命令行入口与交互
│   │   ├── cli.go          参数分发、新会话创建、帮助
│   │   ├── repl.go         交互对话循环、Esc 取消与会话选择
│   │   ├── config.go       config 子命令
│   │   ├── history.go      恢复会话时显示近期对话
│   │   ├── keyboard*.go    Linux/macOS/Windows 终端按键与恢复
│   │   └── render/         终端颜色、Markdown、工具事件显示
│   ├── ai/client.go        模型 HTTP 请求、响应解析、重试
│   ├── agent/
│   │   ├── agent.go        模型 → 工具 → 模型循环
│   │   ├── compact.go      上下文压缩
│   │   ├── prompt.go       配置提示词的环境变量替换
│   │   └── messages.go     模型消息格式辅助函数
│   ├── tools/
│   │   ├── registry.go     工具 schema、分发、运行配置
│   │   ├── shell.go        执行命令
│   │   ├── read.go         读取文件和图片
│   │   ├── write.go        写入文件
│   │   ├── edit.go         精确替换
│   │   ├── helpers.go      输出截断、文件权限等辅助函数
│   │   └── process_*.go    平台相关的进程取消
│   ├── task/
│   │   ├── manager.go      任务创建、容量、状态、事件与会话互斥
│   │   ├── run.go          排队执行、超时、历史恢复
│   │   └── delegate.go     子任务创建与等待
│   ├── server/
│   │   ├── server.go       HTTP 服务配置、启动、关闭
│   │   ├── routes.go       请求解析、任务接口、错误状态码
│   │   ├── auth.go         Bearer Token 鉴权
│   │   └── sse.go          实时事件输出与重连
│   ├── events/events.go    终端与 HTTP 共用的结构化事件
│   ├── history/            按字节偏移读取消息与摘要、会话元数据
│   ├── storage/            数据目录、全局状态、原子写入（不迁移旧数据）
│   └── config/             模型配置、defaults.json 提示词模板、环境变量、路径选择
├── docs/                   架构与 HTTP API 文档
├── install.sh              Linux/macOS 安装入口
├── install.ps1             Windows 安装入口
└── .github/workflows/      检查、跨平台编译和发布
```

## 依赖与事件

交互入口同时启动 HTTP 监听，退出时取消 API 任务、等待历史恢复并关闭服务。
CLI 直接驱动 agent；HTTP 通过 task 管理器驱动 agent；两者共用会话互斥：

```text
cmd/agent → cli → agent → ai
             │      ├── tools
             │      └── history → storage
             └── server → task → agent

agent → events → cli/render 显示
               → task 保留事件 → server/SSE 输出
```

上面的事件箭头代表事件流。代码上 events 只定义数据，不导入任何消费者。
agent 不导入终端渲染或 HTTP 服务；task 不处理鉴权、HTTP 请求和状态码。
任务管理器返回业务错误，由 server 转成 400、409、429、503 等 HTTP 状态。
终端与服务端各自消费事件，避免核心循环里判断“这是终端还是网站”。
`delegate` 由 task 注入 agent；子任务复用暂停父任务的执行名额。

## 修改功能时去哪里

| 要改什么 | 先看哪里 |
|---|---|
| 加工具 | tools/registry.go 和新的工具实现文件 |
| 改模型请求、重试 | ai/client.go |
| 改模型工作循环 | agent/agent.go |
| 改上下文压缩 | agent/compact.go |
| 改并发、取消、子任务 | task/ |
| 加网站调用接口 | server/routes.go |
| 改端口（默认 9528） | config/defaults.json 的 api.listen |
| 改终端展示 | cli/render/ |
| 改会话保存方式 | history/ |
| 改数据目录与初始化 | storage/ 和 config/ |

测试文件使用 `_test.go`，与被测代码放在一起。执行 `go test -race ./...` 和 `go vet ./...` 检查。
没有引入数据库、网页框架或应用宿主，编译入口仍为 `./cmd/agent`，现有安装脚本和发布入口保持兼容。
