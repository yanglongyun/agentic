# 把对话导出成 Markdown

> 写给 agentic 里的 agent。用户已经同意加这个功能。下面说清楚要做成什么样，以及出厂版本里相关代码在哪；
> 你现在的样子可能已经和出厂版本不一样了，按意思做，别硬套。

## 做成什么样

- 侧栏里每个对话的「更多」菜单（置顶 / 重命名 / 删除那个）多一项「导出为 Markdown」，放在「删除」上面。
- 点了之后弹出系统的保存对话框，默认文件名是对话标题（去掉文件名里不能用的字符）加 `.md`，默认放在「下载」目录。
- 文件内容：
  - 第一行 `# 对话标题`，第二行空行，第三行 `导出于 2026-10-28 14:30`（本地时间）。
  - 之后按顺序是每条用户消息和助手回复：用户的写成 `## 我`，助手的写成 `## agentic`，下面是正文原文（本来就是 Markdown，原样放）。
  - 用户发的图片写一行 `（图片）`；工具调用、工具结果、思考过程、压缩摘要都不导出。
- 保存成功给一个轻提示「已导出」；用户取消就什么都不做。

## 出厂版本里的相关代码

- 菜单：`ui/src/shell/Sidebar.tsx`，搜 `role="menuitem"`。
- 拿消息：`GET /api/sessions/:id/messages?limit=500&before=<最早一条的 id>`，返回 `{ messages, has_more }`，
  每条是 `{ id, item, created_at }`，`item` 是 Responses 协议的条目。分页往前翻直到 `has_more` 为 false。
  只要 `item.type === "message"` 的：`role` 是 `user` 时取 `input_text`，是 `assistant` 时取 `output_text`。
- 保存对话框：launcher 的 `dialog.save` 能力（见契约），服务端经 `globalThis.agentic.call("dialog.save", { defaultPath, filters })` 调。
  `defaultPath` 用 `path.join(os.homedir(), "Downloads", 文件名)`。

## 建议的做法

1. 服务端加 `POST /api/sessions/:id/export`：在服务端读库拼好 Markdown（SQL 直接写在接口里，和别的接口一样），
   调 `dialog.save` 拿到路径，写文件，返回 `{ path }`；用户取消时返回 `{ path: null }`。不经 launcher 跑时返回 409。
2. 界面菜单项调这个接口，按返回值提示。
3. 改了 server/ 要 `agentic restart`；跑一下 `npm test` 不需要（用户机器上没有 npm），自己用一个真实对话导出一次看看文件对不对。
4. `agentic snapshot "对话可以导出成 Markdown"`，更新 AGENT.md 的目录说明，然后 `agentic news added export-markdown`。
