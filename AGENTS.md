# 开发约定

- 仓库分三层：`shell/`（Electron 宿主）、`launcher/`（不变层，纯 Node，不 import Electron）、`app/`（出厂应用，agent 能改的身体）。
  launcher 和 app 之间只有 `globalThis.agentic` 这一条 IPC 约定，能力清单和契约版本写在 `launcher/CONTRACT.md`，改能力就同步改它。
- `shell/`、`launcher/` 沿用四空格缩进和现有写法；`app/` 按 [app/AGENTS.md](app/AGENTS.md)，提交前在 `app/` 里跑 `npm run format`。
- 没有传统升级：不写「新安装包覆盖用户 workspace」的逻辑。新功能做进 `app/`，再在 `news/` 发一条写给 agent 的说明（见 README「发布新东西」）。
- 改完跑 `npm test`（launcher + 应用）；改了界面跑 `npm run build:ui`，`app/ui/dist` 跟源码一起提交（出厂就带编好的界面）。
- 不提交任何密钥：签名、公证用的私钥和凭据只放本机（`.gitignore` 已列出）。
