# macOS Computer Use

`computer` 是 Agent 的一个普通工具，只接收两个字段：

```js
{
  summary: "读取文本编辑的窗口",
  code: 'const app = computer.app("com.apple.TextEdit"); await app.focus(); return await app.state();'
}
```

## 调用流程

```text
Agent → functions/computer.js → server/computer/worker.js
      → 父子进程 IPC → desktop/computer/index.js
      → agentic-computer（Swift）→ macOS 原生接口
```

`server/computer/index.js` 负责脚本生命周期、取消、超时和截图保存。每次调用新建执行线程，变量不跨调用保存。线程里的 JS 只组织原生方法调用；VM 不作为安全沙箱。

`desktop/computer/index.js` 负责本机开关、权限入口、原生进程通信和停止快捷键。只允许宿主设置页请求授权，工具对象没有授权方法。一个脚本占用 Mac 控制，操作按顺序执行。

`desktop/computer/main.swift` 调用 Accessibility 读取界面与执行元素操作，使用 CGEvent 发送鼠标键盘事件，使用 ScreenCaptureKit 截图。辅助进程通过标准输入输出交换逐行 JSON，不开放端口。打包时编译并随 App 签名。

## 开启

在桌面客户端的「设置 → Mac 控制」中开启控制，分别授予辅助功能和屏幕录制权限，然后刷新权限状态；系统要求重启时重启客户端。首次默认关闭，不自动申请或修改系统权限。

开启是本机范围：这台电脑上运行的 Agent，包括远程对话，都可以使用。截图会发送给当前配置的模型。

`⌘⇧Esc` 立即停止并关闭控制，之后必须手动重新开启。也可以使用设置中的「关闭控制」或聊天停止按钮。快捷键注册失败会在设置中显示。

## JavaScript 接口

```js
return await computer.apps();
// [{ bundleId, name, pid, active }]
```

```js
const app = computer.app("com.apple.TextEdit");
await app.focus();
return await app.state();
```

- `computer.open(bundleId)`：打开已安装应用，返回应用对象。
- `computer.app(bundleId)`：选择已经运行的应用。
- `computer.apps()`：列出常规桌面应用。
- `computer.displays()`：列出显示器 ID、bounds 和主屏标记。
- `computer.permissions()`：读取权限状态。
- `computer.screenshot(displayId?)`：截图指定屏幕；不传时使用主屏。

应用对象：

| 方法                                      | 用途                                              |
| ----------------------------------------- | ------------------------------------------------- |
| `focus()`                                 | 切到前台                                          |
| `state()`                                 | 读取应用窗口、菜单和界面元素                      |
| `screenshot()`                            | 截取应用的当前窗口                                |
| `click(elementId)`                        | 执行元素的 AXPress                                |
| `action(elementId, action)`               | 执行 state 返回的 actions 中的动作                |
| `setValue(elementId, text)`               | 设置可编辑元素的值                                |
| `click(x, y, button = "left", count = 1)` | 按屏幕逻辑坐标点击；支持 right 和双击             |
| `type(text)`                              | Unicode 输入，不修改剪贴板                        |
| `press(key)`                              | 快捷键，如 cmd+a、cmd+shift+s、enter、tab、escape |
| `scroll(x, y, dy, dx = 0)`                | 在指定坐标滚动，正数向下、向右                    |
| `drag(fromX, fromY, toX, toY)`            | 拖拽                                              |

所有方法都必须 `await`，脚本用 `return` 返回结果。状态、截图结果可以跨模型轮次使用，但 JS 变量不能跨工具调用保存。

## 界面与坐标

`state()` 返回 `app`、`snapshot`、`elements`、`truncated`。每个元素包含 `id`、`role`、文本属性、可用动作、位置和父元素 ID。密码框不返回值。最多读取 1000 个节点，深度 18 层，约 5 秒；截断时返回 `truncated: true`，可以使用截图继续观察。

元素 ID 属于最近一次快照。新的 state 或一次操作会使旧引用失效，不能反复使用同一编号。原生元素已失效或动作不支持时明确报错，不自动改为坐标点击。

坐标统一为 macOS 全局屏幕逻辑坐标，主屏幕左上角为原点，多屏可能出现负坐标。截图返回 `bounds` 和 `scale`：

```js
const x = shot.bounds.x + imageX / shot.scale;
const y = shot.bounds.y + imageY / shot.scale;
await app.click(x, y);
```

截图通过现有图片模块保存文件，工具返回 `imageURL`、图片尺寸和坐标信息。最后一张截图附在标准工具结果中，Base64 不进入消息数据库。

## 停止和边界

- 输入操作要求目标应用在前台；焦点改变时停止操作，不自动抢回焦点。
- 全局快捷键和关闭开关会终止辅助进程及当前脚本；拖拽中的鼠标会释放。
- 单次脚本最多 60 秒；普通原生操作最多 15 秒；长文本分段输入最多 60 秒，权限对话单独等待 120 秒。
- 失败、超时或用户停止后先重新读取界面，不自动重试点击或输入。
- 当前支持 macOS 13+；Windows/Linux 明确返回不支持。
- AX 信息取决于目标应用；自绘界面通常需要截图和坐标操作。
- 屏幕锁定、受系统保护的内容和权限对话仍服从 macOS 的限制。
- 当前没有全局键鼠接管检测；用停止快捷键接管，同应用内手动移动鼠标本身不会停止脚本。

开发启动 `npm run app` 会编译 Swift 辅助程序。单独构建使用 `npm run app:prepare`，需要 Xcode Command Line Tools。安装后的客户端不需要 Node.js 或 Swift 开发环境。

## 实测记录（2026-09-17）

桌面签名测试包通过 Agent 调用原生程序，在 TextEdit 新建文稿中验证：

- 前台切换、界面树读取、坐标点击、中文与 emoji 输入、快捷键。
- 60 行、890 字符的多行输入，读取真实文本逐字比较完全一致。
- 向上和向下滚动，读取滚动条值确认变化。
- 标题栏拖动，读取窗口位置确认移动。一次 40 点拖动实际移动 38 点；系统的拖动起始阈值会影响窗口位移，操作后需要复查。
- `AXPress` 切换粗体，读取值确认 `0 → 1 → 0`。
- 目标窗口截图，尺寸和位置与窗口相符；数据库只有图片地址，没有 Base64。
- `⌘⇧Esc` 中断当前原生调用并关闭控制；设置开关可以重新开启。

实测修复了主线程事件循环缺失导致的前台切换失败，以及快捷键修饰状态、多字符输入事件导致的丢字。文本输入逐字符发送，不使用剪贴板；长文本应分次调用，单次脚本仍受 60 秒超时约束。

自动检查：服务端 52 项、桌面 7 项、界面 11 项测试通过；JS 语法检查、UI 构建、JS/TS 和 Swift 格式检查通过。
