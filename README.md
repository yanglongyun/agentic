# agentic

一个安装在终端里的跨平台 AI agent。使用 OpenAI Responses API 运行工具循环，支持
Linux、macOS 和 Windows。发布包是单个 Go 二进制，用户不需要安装 Go、Python 或 Node.js。

## 安装

Linux / macOS：

```sh
curl -fsSL https://raw.githubusercontent.com/yanglongyun/agentic/main/install.sh | sh
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/yanglongyun/agentic/main/install.ps1 | iex
```

然后配置并开始对话：

```sh
agent config
agent
```

## 用法

```sh
agent                         # 交互对话
agent "检查一下磁盘空间"      # 单次提问，接着当前会话
echo "分析这个日志" | agent

agent config show
agent config set model gpt-4o-mini
agent history
agent compact
agent reset
agent version
```

## 工具

| 工具 | 功能 |
|---|---|
| `shell` | Linux/macOS 使用 Bash，Windows 使用 PowerShell，支持超时和输出截断 |
| `read` | 读取带行号文本；png/jpg/gif/webp 会作为图片交给模型 |
| `write` | 完整写入文件，自动创建父目录 |
| `edit` | 精确字符串替换，默认要求唯一匹配 |

Agent 最多连续运行 50 轮。对话超过配置的 token 水位后，会总结早期上下文并保留近期原文；
完整消息仍追加保存在 `archive.jsonl`。

## 数据位置

| 平台 | 配置 | 会话数据 |
|---|---|---|
| Linux | `~/.config/agentic/config.json` | `~/.local/share/agentic/` |
| macOS | `~/Library/Application Support/agentic/config.json` | 同目录 |
| Windows | `%APPDATA%\agentic\config.json` | `%LOCALAPPDATA%\agentic\` |

环境变量 `AGENT_URL`、`AGENT_KEY`、`AGENT_MODEL`、`AGENT_SYSTEM` 优先于配置文件。

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

推送版本标签后，GitHub Actions 会测试并生成六个发布包：

```sh
git tag v0.1.0
git push origin v0.1.0
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
