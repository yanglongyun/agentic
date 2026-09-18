# 项目代码要求

- 优先让人能直接读懂。使用普通函数、对象、数组和明确的 `if / switch / for`。
- 当前处于开发阶段，禁止任何旧版本、旧字段、旧协议、旧数据结构的兼容或迁移代码，也不保留对应测试、升级脚本和过渡分支。只实现当前确定的结构；开发数据需要重建时直接重建，不为它增加产品代码。
- 固定数据直接写字面量。工具定义直接写数组，不用工厂函数拼装。
- 不给函数动态挂属性，不用立即执行函数隐藏流程，不用隐式类型转换或位运算表达普通数字。
- 条件和循环必须写大括号。每条变量声明只声明一个变量，不写嵌套三元表达式。
- DDL 统一放在 `server/db.js`，启动时初始化。
- 表字段先放标识和业务数据，时间字段放最后；messages 顺序为 id、session_id、item、usage、created_at。
- API 按 URL 路径逐层拆目录，每层用 `index.js` 分发；同一路径的多个 HTTP 方法分别写在 `get.js`、`post.js` 等文件中。
- SQL 直接写在对应 API 处理函数内，不建 repository/service 层，不封装查询、写入或事务方法。
- 注释解释用途和必要的边界处理，变量名表达含义。
- 提交改动前执行 `npm run format`，用 `npm run format:check` 检查格式。
- 修改运行逻辑后执行 `npm run check`、`npm test`；修改界面后执行 `npm run ui:build`。

## Agent 职责

- `server/agent/index.js` 是真正的消息入口和循环体，负责模型请求、压缩及事件输出。
- Agent 工具循环不设置轮数上限。
- Agent 直接使用调用方传入的消息数组，不深拷贝或另建消息副本。
- Agent 和 AI 请求入口按 instructions、messages、model 的顺序接收指令、消息和模型，再接配置等参数；主模型指令由业务层准备，Agent 原样透传。
- 主模型请求和压缩请求都使用独立的 model 参数，不从 config 读取或回退。
- 工具调用只使用标准 call_id，arguments 只接受 JSON 字符串；不得改用 id、生成替代 ID 或接受其他参数格式。
- Agent 和压缩函数直接导入 AI 请求方法，不从调用方传入模型请求函数，不传 hasSummary 状态。
- Agent 对外只发九种事件：message、reasoning、function_call、function_call_output、retry、usage、compact、done、error。结构与时机见 `dev/agent-events.md`。
- 完整模型块按 output 原顺序交付，然后发 usage，最后执行工具；done 每次运行只发一次。
- `server/agent/runner.js` 只接收工具调用，解析参数，执行工具并返回结果。
- 每次请求模型前，根据上次模型返回的 `usage.total_tokens` 判断压缩，禁止估算或累加历史 usage。用户输入时从数据库读取，工具循环使用上次响应用量。
- `messages.usage` 保存原始 usage JSON，只附在每次模型响应最后一项；摘要必须先入库，再继续请求模型。
- 工具图片直接放在 function_call_output.output 数组中，不另造 user 消息。图片存文件，数据库和事件只存图片地址；AI 请求入口读文件转 Base64，仅用于本次请求，不修改原消息。
- `runner.js` 直接导入工具实现，`functions` 目录不设置 `index.js`。浏览器工具只接收 summary、code；页面选择与具体操作写在 JavaScript 中。

## UI 构建

- `desktop/` 只负责桌面窗口、本地服务生命周期和浏览器本机能力；保留 `server/` 的 Agent、API、数据库职责。
- 浏览器界面在 `ui/src/browser/`，沿用 agentic 样式，不引入 worktop 的分屏工作区。Agent 经父子进程 IPC 调用 Electron 的浏览器能力，网页不接触后端令牌。
- 浏览器标签按对话归属，切换对话切换标签集合；草稿转正保留原网页，后台操作不切换当前对话，删除对话清理标签。浏览器工具的 sessionId 由业务层经 IPC 传递，UI 与主进程核对页面归属，不由模型提供。
- 浏览器标签持久化统一使用 `browser_pages`；前端只保留运行状态，禁止使用 localStorage 保存标签。草稿网页用空 session_id，转正通过 API 修改归属，删除对话在同一事务中删除标签。
- 收起浏览器、切换对话/网页标签和进入设置时保留网页实例。各对话共享网页 Cookie，网页存储与聊天登录分区隔离。

- 前端构建产物统一放在 `ui/dist`，由 `server/index.js` 直接托管。
- 发布包保留 `ui/dist` 的路径，不向 server 目录复制静态文件。

- 前端页面由 URL 路由决定：新对话 `/`、会话 `/sessions/:id`、设置 `/settings`、登录 `/login`。不再用 page 状态或本地保存的会话 ID 决定页面。
- 回复结束后不重新查询消息或会话列表，压缩完成后不重新查询摘要。API 通过 WS 业务事件交付保存确认和会话信息，前端直接更新；确认只在事务提交后发送，不修改标准 item。

- Agent 九种运行事件与聊天业务协议分层。WS 协议见 `dev/chat-protocol.md`；断开订阅或连接不取消运行，只有显式 cancel 或服务关闭才中止。
