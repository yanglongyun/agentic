# agentic

一个支持终端对话和 HTTP 调用的跨平台 AI agent。使用 OpenAI Responses API 运行工具循环，
支持 Linux、macOS 和 Windows。发布包是单个 Go 二进制，用户不需要安装 Go、Python 或 Node.js。

## 安装

安装脚本下载最新 GitHub Release。`main` 中尚未发布的功能需要从源码编译，
仅推送代码不会更新 Release 中的二进制。

Linux / macOS：

```sh
curl -fsSL https://raw.githubusercontent.com/yanglongyun/agentic/main/install.sh | sh
```

root 默认安装到 `/usr/local/bin`，普通用户默认安装到 `~/.local/bin`。
可通过环境变量 `AGENT_BIN_DIR` 指定安装目录。如果该目录不在 PATH 中，
请执行安装脚本输出的 `export PATH=...` 命令，或使用输出的完整路径启动。

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/yanglongyun/agentic/main/install.ps1 | iex
```

然后配置并开始对话：

```sh
agent config
agent
```

## HTTP 服务

支持 `agent serve`，供网站后端调用：异步任务、独立会话、SSE 实时事件、取消和 `delegate` 子任务。
先运行 `agent config` 配置模型，再设置独立的服务访问令牌（至少 16 字符）：

```sh
export AGENT_SERVER_TOKEN="$(openssl rand -hex 32)"
agent serve
```

默认监听 `127.0.0.1:9528`。网站后端使用相同令牌调用；不要把令牌放在浏览器前端。
例如，在已设置相同令牌的另一个终端创建任务：

```sh
curl -sS http://127.0.0.1:9528/v1/tasks \
  -H "Authorization: Bearer $AGENT_SERVER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"查看当前目录并概括项目"}'
```

返回任务 ID；查询 `GET /v1/tasks/<id>`，订阅 `GET /v1/tasks/<id>/events`，
取消使用 `POST /v1/tasks/<id>/cancel`。省略 `session_id` 创建新会话，传入已有 ID 继续对话。
服务默认并发 4、子任务深度 2、超时 10 分钟，可通过 `agent serve -h` 查看参数。
完整启动示例、接口和限制见 [HTTP API 文档](docs/http-api.md)。

## 用法

```sh
agent                         # 开启新的交互会话

agent config show
agent config set model gpt-4o-mini
agent history
agent compact
agent version
```

## 工具

| 工具 | 功能 |
|---|---|
| `shell` | Linux/macOS 使用 Bash，Windows 使用 PowerShell，支持超时和输出截断 |
| `read` | 读取带行号文本；png/jpg/gif/webp 会作为图片交给模型 |
| `write` | 完整写入文件，自动创建父目录 |
| `edit` | 精确字符串替换，默认要求唯一匹配 |
| `delegate` | 仅 HTTP 服务模式：创建独立子任务并等待结果，受层级和超时限制 |

Agent 最多连续运行 50 轮。对话超过配置的 token 水位后，会总结早期上下文并保留近期原文；
完整消息只追加到 `messages.jsonl`；压缩摘要和覆盖边界追加到 `compactions.jsonl`。
当前上下文由已生效的最新摘要与其后的未压缩消息构成，不再保存另一份 history 文件。

## 数据位置

所有运行数据统一放在一个目录，不使用数据库：

```text
agentic/
├── config.json             # 模型配置
├── state.json              # 当前 CLI 会话 ID
└── sessions/
    └── <会话ID>/
        ├── session.json        # 会话信息、用量、起点和有效压缩记录
        ├── messages.jsonl      # 完整消息历史，只追加
        └── compactions.jsonl   # 压缩摘要和覆盖边界，只追加
```

| 平台 | 默认根目录 |
|---|---|
| Linux | `~/.config/agentic/`（遵循 XDG_CONFIG_HOME） |
| macOS | `~/Library/Application Support/agentic/` |
| Windows | `%APPDATA%\agentic\` |

可用 `AGENT_HOME` 指定统一根目录。兼容旧目录变量，根目录优先级为
`AGENT_HOME` > `AGENT_DATA_DIR` > `AGENT_CONFIG_DIR` > 平台默认目录。
每次启动 `agent` 创建新的 `sessions/cli-<随机ID>/`，不自动续聊旧会话。
HTTP 会话也位于 `sessions/`；省略 session_id 即创建新会话，提供已有 ID 则继续该会话。
同一会话不应由 CLI 和 HTTP 或多个进程同时操作。

不提供旧数据迁移，不复制、重命名或删除旧文件。发现选定目录中的旧格式会话会报错。
需要保留旧数据时，请使用新的 `AGENT_HOME` 或新会话 ID，并重新配置模型。
不提供单次参数提问、管道提问或 reset。退出后重新运行 `agent` 即开启新会话，旧记录保留。
`agent history` 和 `agent compact` 操作最近创建的 CLI 会话。
失败或取消的任务消息同样保留，但通过会话元数据排除出后续模型上下文。
顶层状态不保存任务执行进度；HTTP 任务状态和事件仍在内存，重启不恢复。

环境变量 `AGENT_URL`、`AGENT_KEY`、`AGENT_MODEL`、`AGENT_SYSTEM` 优先于配置文件。

## 上下文读取与性能

会话格式 `format: 3` 使用字节偏移：`session.json` 中的 `compaction` 定位当前生效的压缩记录
（-1 表示尚未压缩）；压缩记录的 `through` 定位 `messages.jsonl` 中未压缩部分的起点。
每轮只解析该条摘要与后续消息，不扫描完整消息历史或全部压缩记录。
取消任务的消息范围同样按字节跳过，检查点和恢复通过文件大小定位，历史仍保留。

SSE 按事件变化唤醒，只发送游标之后的新事件；空闲连接每 15 秒发送心跳。
最近 64 条事件复用有界缓冲区。消息写入仍保留落盘同步，不以放弃持久性换取速度。
性能随当前未压缩上下文长度增长，而不是随已经压缩的历史长度增长。
此前的会话格式不做迁移，请使用新会话或新数据目录。

## 提示词配置

提示词保存在数据根目录的 `config.json`，首次运行会生成默认配置：

- `system`：主提示词。
- `compact_system`：上下文压缩提示词。
- `compact_prefix`：压缩摘要进入上下文时的前缀。

可以直接编辑 JSON，或执行：

```sh
agent config set system "你的主提示词"
agent config set compact-system "你的压缩要求"
agent config set compact-prefix "历史摘要："
agent config show
```

支持变量 `{{os}}`、`{{arch}}`、`{{host}}`、`{{user}}`、`{{workdir}}`、`{{time}}`。
空字符串表示不添加相应提示词，不会触发代码中的备用文本。
`AGENT_SYSTEM` 非空时仍优先于配置中的 `system`。
CLI 在启动时读取配置；修改后下次启动生效，运行中的 `agent serve` 需要重启。
仓库默认模板位于 `internal/config/defaults.json`，运行时以用户配置为准。

## 代码结构

核心模块按 `ai`（模型）、`agent`（循环）、`tools`（工具）、`task`（任务）、
`server`（HTTP）、`cli`（终端）划分。中文目录说明与修改入口见 [代码架构](docs/architecture.md)。

## 开发

需要 Go 1.22 或更新版本：

```sh
make check
make build
./dist/agent version
```

本地交叉编译示例：

```sh
GOOS=windows GOARCH=amd64 go build -o dist/agent.exe ./cmd/agent
```

## 发布

推送 `main` 或提交 PR 会运行测试、竞态检测、静态检查及六个平台的编译检查；
这些检查不会创建 Release。发布由 `v*` 标签触发，标签需使用尚未发布的新版本号。

推送版本标签后，GitHub Actions 会测试并生成六个发布包：

```sh
git tag vX.Y.Z
git push origin vX.Y.Z
```

- Linux amd64 / arm64
- macOS amd64 / arm64
- Windows amd64 / arm64

安装脚本检测系统和 CPU 后，从最新的 GitHub Release 下载对应文件。

## 安全说明

`shell` 工具能以当前用户权限执行命令。请在可信目录和低权限账户中使用，不要把 API Key
写入提示词、命令输出或仓库文件。

## License

MIT
