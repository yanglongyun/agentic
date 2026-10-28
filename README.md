# agentic

一个跑在你电脑上的 AI 助手。左边是对话列表，右边是对话。它能在你的电脑上执行命令、读写文件；装上浏览器插件后，还能操作你的 Chrome / Edge。
模型用你自己的（BYOK）：接口地址、Key、模型名在设置里填，没有云端账号。

它还有一个平时看不见的能力：**能按你的需要改它自己。** 嫌侧栏太宽、想要一个导出按钮、想给它加一个工具，直接跟它说，
它会改自己的界面和功能，改完马上生效。每次改动都记在设置的「改动记录」里，不满意可以退回任何一次。

## 没有传统的升级

agentic 不会推新版本覆盖你的应用——你改过的地方就是你的。官方发布新功能时，侧栏会出现一张「新东西」卡片：
点「了解一下」，它会告诉你这是什么、加上后是什么样，你要了它就照着说明在自己身上加；点「不要」就不再提。

## 目录

```text
shell/       桌面壳（Electron 主进程）：窗口、通知、对话框、菜单栏图标
launcher/    不变层（纯 Node）：播种、快照、起不来就回滚、编译界面、浏览器通道、改动记录、新东西、agentic 命令
             CONTRACT.md 是写给 agent 的契约，每轮都在它的指令里
app/         出厂应用 = agent 能改的身体：本地服务、Agent 循环、工具、界面（React）。装好后拷进用户的 workspace
extension/   浏览器插件（Chrome / Edge），经原生消息连到 launcher
news/        新东西的发布源：index.json 列表 + 每条写给 agent 的实现说明
build/       图标、签名配置；scripts/ 打包
```

用户机器上的数据在 `~/Library/Application Support/ai.agentic`（Windows 是 `%APPDATA%\ai.agentic`）：
`workspace/` 是应用本身（一个 git 仓库），`data/` 是对话和模型配置，`launcher/` 是启动记账、日志和新东西的状态。

## 开发

要求 Node.js 22.5 或更高版本。

```bash
npm ci && npm ci --prefix app && npm ci --prefix app/ui
npm run app          # 编译界面，用 Electron 启动（仓库里的 app/ 就是出厂种子）
npm test             # launcher 测试 + 应用测试
npm run pack:mac     # 出 Mac 应用到 dist/mac-arm64/（本地包，不签名）
```

开发时想用一份和日常数据分开的目录：`AGENTIC_HOME=/tmp/agentic-dev npm run app`。

改 `app/` 的约定见 [app/AGENTS.md](app/AGENTS.md)；agent 自己维护的说明在 [app/AGENT.md](app/AGENT.md)。

## 发布新东西

1. 在 `app/` 里把功能做好，作为参考实现提交（新装的用户直接带着它）。
2. 在 `news/` 加一份写给 agent 的实现说明 `<id>.md`：做成什么样、出厂版本里相关代码在哪、建议的做法、做完要记的命令。
   说明要按「意思」写——用户的 agentic 可能已经被改得和出厂版本不一样了。
3. 在 `news/index.json` 的 `items` 里加一条 `{ id, date, title, summary, guide }`。
4. 把 `id` 加进 `app/package.json` 的 `agentic.news`：新装的用户出厂就带着，不会再被提示。
5. 推到 main。用户的 agentic 每隔几小时拉一次 `news/index.json`。

## 浏览器插件

插件在 `extension/`（打包后在应用的 `Contents/Resources/extension`，设置里有「打开插件文件夹」）。
在 Chrome 打开 `chrome://extensions`，打开「开发者模式」，「加载已解压的扩展程序」选这个文件夹。
插件 ID 由 `manifest.json` 里的 `key` 固定为 `mgiphoedkmmckhdebcmkfceibndnioio`，launcher 启动时把原生消息宿主 `ai.agentic.browser` 登记到本机浏览器。

## 许可

MIT
