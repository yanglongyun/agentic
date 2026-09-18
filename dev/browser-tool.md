# 浏览器工具

工具只有两个参数：`summary`（操作说明）和 `code`（JavaScript）。仅桌面 App 可用，操作的是右侧已有浏览器和它的登录状态。

```json
{
  "summary": "读取网页标题与正文",
  "code": "const tabs = await browser.tabs(); const page = browser.page(tabs[0].id); return await page.evaluate(() => ({ title: document.title, text: document.body.innerText }));"
}
```

## 用法

```js
const tabs = await browser.tabs(); // [{ id, title, url, active }]
const page = await browser.open("https://example.com");
// 或者：const page = browser.page(tabs[0].id);

await page.goto("https://example.com/news");
await page.focus();
const text = await page.evaluate(() => document.body.innerText);
return { id: page.id, text };
```

`code` 是异步函数体，支持 `await` 和 `return`。每次调用独立执行，变量不跨调用保留；下一次用标签 id 重新取得 page。所有异步方法都要 await，不启动后台任务。

### 网页 JS

```js
const page = browser.page("从 tabs 返回的 id");
return await page.evaluate((selector) => {
  const element = document.querySelector(selector);
  return element ? element.textContent : null;
}, "h1");
```

外层能用 `browser`，不能直接用 `document`。`evaluate` 的函数进入网页隔离环境，能用 `document`，但不能引用外层变量；通过第二个参数传入 JSON 数据。支持返回 Promise，返回值应为 JSON 数据。

隔离环境与网页共享 DOM，但不共享网页主环境的全局变量。当前版本执行主 frame；同源 iframe 可以通过 DOM 访问，跨源 iframe 和主环境变量访问暂不提供。

### 真实输入和截图

```js
const page = browser.page("从 tabs 返回的 id");
const point = await page.evaluate(() => {
  const box = document.querySelector("input").getBoundingClientRect();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
});
await page.click(point.x, point.y); // 网页视口内 CSS 像素坐标
await page.type("hello"); // 在当前聚焦位置输入，触发浏览器输入事件
await page.press("Enter");
return await page.screenshot();
```

`press` 支持 Enter、Tab、Escape、Backspace、Delete、ArrowLeft/Up/Right/Down、Home、End、PageUp/Down、Space；不支持组合键。滚动、读取和 DOM 操作直接写在 evaluate 中。

`screenshot()` 返回图片地址、宽高和网址。截图在后端落盘；消息只保存 `/api/images/...`，不保存 Base64。本次最后一张截图同时作为工具图片交给模型；一轮需要多张时分多次工具调用。

`await page.close()` 关闭指定标签，空白标签也可关闭或通过 goto 导航。

## 执行链路

```text
server/agent/functions/browser.js
  → server/browser/index.js
  → server/browser/worker.js（独立线程执行 code）
  → 父子进程 IPC
  → desktop/browser/control.js（CDP 执行页面操作）
  → ui/src/browser/control.ts（新建、切换、关闭标签）
```

不开放新的 HTTP 或调试端口。外层执行线程用于隔离生命周期和取消，并非恶意代码的安全沙箱。页面自身继续关闭 Node 集成，并与聊天登录使用不同分区。

每次脚本最多执行 60 秒，单次网页 JS 执行设置 5 秒计算超时。停止对话会终止执行线程、撤销待执行请求并尝试终止当前网页 JS；已发生的点击、输入等无法撤销。超时后先重新观察页面，不能盲目重放动作。

同一对话只运行一个浏览器脚本，脚本内操作串行执行。用户操作脚本正在使用的网页时，中止该脚本；其他标签不受影响。远程对话也能触发本机浏览器工具，操作范围仍限于该对话的网页。

## 对话与网页归属

每个对话保存独立的标签集合、选中标签和面板开关。新对话发送首条消息后，草稿网页归到新会话，保留原 webview；切换对话或进入设置不会销毁已加载的网页。页面弹窗跟随来源标签，不跟随用户后来切换到的对话。

标签记录保存在 SQLite 的 `browser_pages` 表，按 `session_id` 归属对话；空字符串表示尚未发送消息的草稿。字段为 `id、session_id、url、title、icon、position、active、created_at、updated_at`。发送首条消息后通过 API 把草稿记录归到新对话，保持标签 ID 和创建时间。

- `GET /api/browser/pages`：启动时读取标签；可用 `session_id` 查询单个对话，传空值查询草稿。
- `PUT /api/browser/pages`：接收 `{ session_id, pages }`，在事务中保存该对话完整的标签顺序、选中项和元数据，删除已经关闭的标签；不允许占用其他对话的标签 ID。
- `POST /api/browser/pages/claim`：接收 `{ session_id }`，将草稿网页归到新对话。

界面的保存请求串行执行，防止旧导航或排序覆盖新状态；失败显示错误。浏览器工具修改标签后等待保存结果。数据库只存标签记录，加载状态、网页实例、缩放、关闭记录和面板开关保留在运行内存中。重启后从数据库恢复标签和选中项，只加载当前对话的活动网页；有标签的对话打开浏览器面板。删除对话时在同一数据库事务中删除其标签。

不再用 localStorage 保存或恢复标签，不保留旧数据的兼容、迁移代码。

所有对话继续使用 `persist:agentic-browser`，共享网站登录态；书签、历史、下载与浏览器设置也是全局的。

业务层在运行配置写入 `session_id`，服务器为每个 IPC 请求携带 `sessionId`。桌面脚本运行绑定该对话，UI 先检查标签归属，主进程再核对已登记网页的归属。`browser.tabs()` 只返回本对话网页，`open()` 在本对话创建标签，其他页面方法不能跨对话访问。模型工具参数仍然只有 `summary` 和 `code`。

不同对话的浏览器脚本可以并行；同一对话同时只执行一个脚本。后台运行可以打开、操作、截图自己的网页，但不会把用户正在看的对话或标签切走。网页在隐藏时保留尺寸，供后台输入和截图使用。
