# HTTP 任务 API

先配置模型：`agent config`。然后在希望 agent 工作的目录运行 `agent`。
聊天与 API 同时启动，`agent resume` 也会启动 API；退出聊天时取消 API 任务并关闭监听。
`config`、`version` 等一次性命令不启动监听。
默认地址为 `http://127.0.0.1:9528`，启动信息显示实际地址；端口占用时启动失败。

配置保存在 `config.json` 的 `api` 中（`task_timeout` 单位为秒）：

```json
{
  "api": {
    "listen": "127.0.0.1:9528",
    "token": "首次自动生成的随机令牌",
    "concurrency": 4,
    "max_tasks": 256,
    "max_depth": 2,
    "task_timeout": 600
  }
}
```

可使用 `agent config set api-listen 127.0.0.1:9528` 等命令修改，配置项还包括
`api-token`、`api-concurrency`、`api-max-tasks`、`api-max-depth`、`api-task-timeout`。
环境变量 `AGENT_LISTEN`、`AGENT_SERVER_TOKEN` 分别覆盖监听地址与访问令牌。
`agent config show` 中令牌脱敏；完整令牌从配置文件读取，下面示例假定网站后端已把它设为 `AGENT_SERVER_TOKEN`。

所有接口，包括健康检查，都要求 `Authorization: Bearer <token>`。
令牌至少 16 字符，与模型 API Key 独立；网站浏览器应通过自己的网站后端访问服务。
该 API 是单一可信使用者的机器控制接口，不提供多租户隔离或文件系统沙箱。
所有任务以进程的用户权限运行，使用启动目录；不同会话共享机器文件。
当前 CLI 会话由任务管理器保留，HTTP 尝试写入时返回 409；CLI 也不能切换到正在执行 API 任务的会话。
不要启动多个进程使用同一个数据根目录。

## 创建和查询任务

```sh
curl -sS http://127.0.0.1:9528/v1/tasks \
  -H "Authorization: Bearer $AGENT_SERVER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"查看当前目录并概括项目","session_id":"website-chat-1"}'
```

返回 HTTP 202 和 JSON，包含 `id`、`session_id`、`status`、`depth`、`created_at`。
省略 `session_id` 会创建新会话；传入之前的值可以继续对话。同一会话有任务未结束时返回 409。
会话 ID 仅支持 1–64 个字母、数字、下划线和连字符。prompt 最大 128 KiB。

将返回的任务 ID 放入以下命令：

```sh
TASK_ID=替换成返回的id
curl -sS "http://127.0.0.1:9528/v1/tasks/$TASK_ID" \
  -H "Authorization: Bearer $AGENT_SERVER_TOKEN"
```

状态从 `queued` 到 `running`，等待子任务时为 `waiting`，最终为 `completed`、`failed` 或 `cancelled`。
最终结果在 `result`，失败原因在 `error`，结束时间在 `finished_at`。
任务异步执行，创建请求或事件连接断开不会取消任务。

## 实时事件和取消

```sh
curl -N "http://127.0.0.1:9528/v1/tasks/$TASK_ID/events" \
  -H "Authorization: Bearer $AGENT_SERVER_TOKEN"

curl -sS -X POST "http://127.0.0.1:9528/v1/tasks/$TASK_ID/cancel" \
  -H "Authorization: Bearer $AGENT_SERVER_TOKEN"
```

事件使用 SSE，每条 JSON 包含 `id`、`type`、`text`。
类型包括 `status`、`message`、`tool_call`、`tool_result`、`child`、`warning`。
工具事件还提供 `name`、`arguments`、`call_id`，工具结果附带 `duration_ns`（纳秒）。
原有 `id`、`type`、`text` 字段保留；回放中的 text 和 arguments 各截断到约 8 KiB。
`child` 的 text 是子任务 ID，可通过同样的查询、事件和取消接口访问。
这是消息和工具完成粒度的进度流，不是模型逐 token 输出。
事件变化时立即唤醒连接，空闲时每 15 秒发送心跳，不轮询任务。
可发送 `Last-Event-ID` 恢复连接；只保留最近 64 条事件，每条文本最多 8 KiB。
缺失旧事件时会发送 `gap`，完整最终回答通过任务查询获取。
取消返回 202 表示已请求取消，查询任务确认最终状态。超时记为 `failed`。
Linux/macOS 会终止当前 shell 的进程组；主动脱离进程组的后台程序不在此保证内。
Windows 当前仅保证终止直接子进程。已经写入的文件或其他外部操作不会回滚。
失败或取消会恢复该轮之前的活动对话，完整消息与压缩记录保留。

## 异步 agent 工具

终端和 HTTP 任务都提供 `agent` 工具，输入 `prompt`，立即返回：

```json
{"agent_id":"子任务 ID","status":"queued"}
```

子任务独立运行，不继承父会话历史。`agent_id` 可用现有任务查询、SSE 与取消接口访问。
`child` 事件中的 text 同样是子任务 ID。终端派发的子任务，其 `parent_id` 为父会话 ID；HTTP 派发的子任务，其 `parent_id` 为父任务 ID。
父任务先继续执行自己的工作，子任务结果随后自动进入父会话并触发回复。
HTTP 父任务在等待子任务期间状态为 `waiting`，不占用执行名额；全部结果处理完成后变为 `completed`。
最终 `result` 包含主任务回复及后续结果回复，SSE 也会发送这些消息。

`api.max_depth: 2` 允许主任务 → 子任务 → 孙任务，设为 0 禁止派发。
子任务超时独立计时，HTTP 父任务取消或超时会传递到子任务。
终端 Esc / Ctrl+C 中断当前回复，已派发的子任务继续执行；退出程序时全部取消。

子任务数据保存在父会话的 `agents/<agent_id>/`，包含 `state.json`、`messages.jsonl` 和 `compactions.jsonl`。
嵌套子任务继续保存在自己父任务的 `agents/` 内，均不出现在 `/resume`。
完成结果先持久化，再通知父会话。父会话串行处理结果，成功后写入回执和子任务 handled 标记。
中断或崩溃后未提交的结果处理会恢复先前上下文，已提交的回执用于避免重复处理。
任务执行产生的外部副作用不随上下文恢复而回滚。

## 限制和存储

- `api.concurrency` 默认 4，限制实际并行执行；等待子任务结果的父任务不占名额。
- `api.task_timeout` 默认 600 秒，包含排队与所有子任务时间。
- `api.max_tasks` 默认 256，限制内存任务记录总数；容量满时先淘汰已完成记录，没有可淘汰记录则返回 429。
- 创建新任务时清理超过 24 小时的已完成记录。HTTP 任务索引和 SSE 事件不持久化，重启后查询返回 404；子 agent 的状态和结果保存在会话目录中。未完成的子 agent 不自动重新执行，恢复父会话时会将中断结果交回。
- CLI 与 HTTP 统一使用数据根目录下的 `sessions/<session_id>/`，CLI 发送第一条消息时才创建新的 `cli-<随机ID>` 会话。每个会话包含 `session.json`、`messages.jsonl`、`compactions.jsonl`；磁盘历史需自行管理保留周期。根目录还包含 `config.json` 和记录当前 CLI 会话的 `state.json`，可通过 `AGENT_HOME` 指定。
- 健康检查为 `GET /healthz`；接口错误采用 `{"error":"说明"}`。

源码更新后需要编译或发布新的 Go 二进制才能使用合并后的启动方式。
本地可执行 `go build -o agent ./cmd/agent`；推送 `v*` 标签会由 release 工作流构建发布包。

会话仅支持新格式，不执行旧数据迁移。旧文件保持原样，请使用新数据目录或新会话 ID。
