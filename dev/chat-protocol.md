# 聊天 WebSocket 协议

## 分层

```text
网页聊天 ── WS /api/chat ── API 业务层 ── Agent
远程网页 ── WS ── Worker 房间 ── WS ── 同一个 API 业务层
```

Agent 只交付 [九种运行事件](./agent-events.md)，不知道连接、订阅、数据库和远程房间。API 负责上下文查询、SQL 保存、会话状态，以及下面的业务协议。Worker 转发数据，Agent 和工具始终在本地运行。

本地 WS 使用登录 Cookie 或 Authorization: Bearer。浏览器连接必须同源。每个数据包都是 JSON 文本。

## 网页 → 业务层

所有命令包含 `type`、`request_id`、`session_id`。request_id 使用 UUID。

| type        | 额外字段     | 用途                                              |
| ----------- | ------------ | ------------------------------------------------- |
| subscribe   | 无           | 订阅会话，立即取得快照                            |
| unsubscribe | 无           | 取消订阅，不停止 Agent                            |
| send        | text、images | 发送消息，images 是已上传图片的地址数组，最多五张 |
| cancel      | run_id       | 明确停止指定运行，等待清理完成后确认              |

```json
{ "type": "send", "request_id": "请求UUID", "session_id": "会话UUID", "text": "你好", "images": [] }
```

文字最多 128 KiB。每张图片先 POST `/api/sessions/:id/images`，请求 `{ image: "data:image/png;base64,..." }`，得到 `{ url: "/api/images/UUID.png" }`，再把地址放入 send。单张上限 10 MiB。

## 业务层 → 网页

| type               | 主要数据                                          | 时机                                                  |
| ------------------ | ------------------------------------------------- | ----------------------------------------------------- |
| connected          | session_id                                        | 连接可用；本地为 null，远程为唯一获授权会话           |
| subscribed         | request_id、session_id、snapshot                  | 订阅成功，交付当前完整状态                            |
| unsubscribed       | request_id、session_id                            | 已取消订阅                                            |
| request.accepted   | request_id、session_id、duplicate?、operation?    | send 的用户消息和去重记录提交后；或 cancel 清理完成后 |
| request.rejected   | request_id、session_id、status、error             | 请求未被接受                                          |
| run.started        | session_id、run_id                                | 一轮开始                                              |
| run.event          | session_id、run_id、event、sequence?、created_at? | 原始九种 Agent 事件位于 event，完整 item 不加业务字段 |
| messages.saved     | session_id、run_id、messages                      | 一次事务提交后，交付完整数据库记录及本轮 sequence     |
| compaction.created | session_id、compaction                            | 摘要保存完成                                          |
| session.updated    | session_id、session                               | 新建、改名、消息提交或运行状态变化                    |
| session.deleted    | session_id                                        | 会话删除                                              |
| run.finished       | session_id、run_id、status、stopReason、error     | 整轮执行及文件清理结束                                |
| remote.status      | online、session_id?、enabled?                     | 本地客户端与房间连接状态变化                          |

`run_id` 就是 send 的 request_id。`event.done` 是 Agent 结束；`run.finished` 是业务层完成清理，界面收到后结束运行状态。

`messages.saved.messages` 每项为 `{ id, sequence, item, usage, created_at }`。sequence 从 0 开始，每轮独立递增。前端按 sequence 接管临时消息的数据库 ID。只有事务提交成功才发送；完整 item 和增量本身都不表示已经保存。

工具调用与结果按完整轮次一起提交。取消或失败时，前端丢弃尚未确认的临时块，保留已经保存的轮次。回复结束后不再 GET 消息或会话列表。

## 订阅快照与重连

snapshot 包含：

- session：会话列表项，含 running。
- messages：最近 60 条已保存消息。
- compactions：已保存摘要。
- has_more：能否继续向前分页。
- status：模型名、是否配置完成、工作目录。
- run：最近或当前运行；运行中包含内存里的 live 消息和增量。

页面切换只改变订阅。页面关闭、WS 断开都不取消执行。重连后重新 subscribe，以快照恢复保存内容和正在生成的内容；向前翻页仍走 HTTP。

没有收到确认的 send 会用原 request_id 重发。`chat_requests` 将请求摘要和用户消息在同一个事务中保存，同一 ID 和相同内容只确认，不重复执行；同一 ID 配不同内容返回 409。服务重启后去重仍有效，但进程重启不能继续原先未完成的模型调用，快照会显示该轮未完成。

## 远程入口

本地接口 `/api/sessions/:id/remote`：GET 查看；POST `{ url, key }` 注册 Worker 房间；DELETE 撤销并断开连接。

一个房间只对应一个本地会话。远程 WS 即使提供其他 session_id，也会被本地 API 拒绝。远程 HTTP 仅允许状态、本会话历史/摘要和图片上传/读取，禁止设置、列表和其他会话。

远程链接为 `https://Worker/remote/房间UUID#访问凭据`。网页先交换 HttpOnly Cookie，再移除地址里的凭据。管理密钥只用来注册房间，不发给远程页面。主机凭据与访问凭据独立；Worker 保存其哈希，本地保存重连所需凭据。

Worker 在两端之间转发消息，因此能接触传输内容；这里没有实现端到端加密。Worker 不保存聊天历史和图片；聊天数据保存在本地。

部署及本地联调见 [relay/worker/README.md](../relay/worker/README.md)。

取消命令携带 run_id，重连重发的旧 cancel 不会停止后来开始的新运行。
