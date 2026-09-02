# agent-cli

一个 shell 脚本写的 AI agent。用 OpenAI Responses API 跑 agent 循环，四个工具，
全局一个对话存成 jsonl，上下文自动压缩。

新开一台服务器，一行命令装上，填好 url / key / model 就能对话。
除了 `bash` `curl` `jq`，不需要任何运行时。

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/yanglongyun/agent-cli/main/install.sh | bash
```

装到 `~/.agent-cli`，`agent` 链到 `/usr/local/bin`（没权限就 `~/.local/bin`）。
缺 `jq` 会自动用 apt / yum / apk 装上。

然后：

```bash
agent config     # 填 url / key / model
agent            # 开始对话
```

## 用法

```bash
agent                      # 进对话
agent "看下磁盘还剩多少"     # 问一句就走，接的是同一个会话
echo "分析这个日志" | agent  # 管道也行

agent history              # 打印当前对话
agent compact              # 立刻压缩上下文
agent reset                # 清空对话（原文仍在归档里）
agent config show          # 看配置
agent config set model gpt-4o
```

对话里可用 `/exit` `/reset` `/compact` `/history` `/config` `/help`。

## 工具

| 工具 | 说明 |
|---|---|
| `bash` | 执行 shell 命令，带超时，输出超长自动截断 |
| `read` | 读文件，文本带行号；**图片直接给模型看**（png/jpg/gif/webp） |
| `write` | 整文件写入，父目录自动建 |
| `edit` | 精确字符串替换，默认要求唯一匹配，可 `replace_all` |

图片走的是一条单独的路：Responses API 的 `function_call_output` 只吃字符串，
所以 `read` 读到图片时把 data URL 落到临时文件，主循环在工具结果后面补一条
带 `input_image` 的消息 —— 模型下一轮就真的看得见这张图。

## 上下文压缩

每次 API 返回的 `usage.total_tokens` 超过 `compact-at`（默认 60000），
下一轮开始前压缩早期上下文：

```text
早期上下文 → 模型摘要（失败则机械摘要）→ 摘要 + 最近若干条原文
```

切点必须落在一条 user 消息上，否则保留段开头会出现孤儿 `function_call_output`，API 会报错。

**原文一条都不丢**：`history.jsonl` 是会被压缩重写的当前上下文，
`archive.jsonl` 只追加，每条消息和每次压缩的摘要都在里面。

## 文件

```text
agent-cli/
├── bin/agent           入口：命令分发 + REPL
├── lib/
│   ├── util.sh         颜色、日志、依赖检查、截断
│   ├── config.sh       配置读写
│   ├── history.sh      jsonl 历史 + 归档 + 运行状态
│   ├── api.sh          Responses API 调用（含重试）
│   ├── tools.sh        工具注册与分发
│   ├── compact.sh      上下文压缩
│   ├── loop.sh         agent 循环 + 系统提示词
│   └── tools/          bash.sh · read.sh · write.sh · edit.sh
├── install.sh          一键安装
└── test/               假 API + 端到端自测
```

数据都在 `~/.local/share/agent-cli/`：

| 文件 | 内容 |
|---|---|
| `history.jsonl` | 当前上下文，一行一个 Responses API item，会被压缩重写 |
| `archive.jsonl` | 只追加，完整原文，永不丢 |
| `state.json` | 最近一次 usage |

配置在 `~/.config/agent-cli/config`（权限 600）：

| 项 | 默认 | 说明 |
|---|---|---|
| `url` | `https://api.openai.com/v1/responses` | Responses API 地址 |
| `key` | — | API Key |
| `model` | `gpt-4o-mini` | 模型 |
| `compact-at` | `60000` | 压缩水位（token） |
| `keep` | `20` | 压缩时至少保留多少条 |
| `timeout` | `120` | 单个工具执行超时（秒） |
| `max-output` | `30000` | 工具输出截断（字符） |
| `system` | — | 自定义系统提示词，留空用内置 |

同名环境变量（`AGENT_URL` / `AGENT_KEY` / `AGENT_MODEL` …）优先于配置文件。

## 测试

```bash
./test/run.sh
```

起一个假的 Responses API，用真的 agent 循环跑一遍：工具调用回传、
write/edit 的尾部换行、edit 的唯一性检查、图片转 `input_image`、压缩切点、
配置文件权限，一共 27 项。

## License

MIT
