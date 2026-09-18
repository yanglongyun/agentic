// Agent 的浏览器命令只访问已登记的网页标签，不访问宿主聊天页面。
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import electron from "electron";

const keys = {
  Enter: ["Enter", 13],
  Tab: ["Tab", 9],
  Escape: ["Escape", 27],
  Backspace: ["Backspace", 8],
  Delete: ["Delete", 46],
  ArrowLeft: ["ArrowLeft", 37],
  ArrowUp: ["ArrowUp", 38],
  ArrowRight: ["ArrowRight", 39],
  ArrowDown: ["ArrowDown", 40],
  Home: ["Home", 36],
  End: ["End", 35],
  PageUp: ["PageUp", 33],
  PageDown: ["PageDown", 34],
  Space: ["Space", 32],
};

export function setupControl({ page, send, allowedURL }) {
  const pending = new Map();
  const runs = new Map();
  const pages = new WeakMap();

  function track(contents) {
    if (pages.has(contents)) {
      return pages.get(contents);
    }
    const state = { contextId: null, input: false, usedAt: 0 };
    pages.set(contents, state);
    function activity() {
      if (state.input) {
        return;
      }
      state.usedAt = Date.now();
      for (const run of runs.values()) {
        if (run.pages.has(contents)) {
          run.controller.abort(new Error("browser_user_active：用户正在操作这个页面，请停止控制"));
        }
      }
    }
    contents.on("before-input-event", (_event, input) => {
      if (input.type === "keyDown") {
        activity();
      }
    });
    contents.on("before-mouse-event", (_event, input) => {
      if (input.type === "mouseDown" || input.type === "mouseWheel") {
        activity();
      }
    });
    contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) {
        state.contextId = null;
      }
    });
    contents.debugger.on("detach", () => {
      state.contextId = null;
    });
    return state;
  }

  function ask(method, args, run) {
    const signal = run.controller.signal;
    signal.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      function finish(error, result) {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        pending.delete(id);
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      }
      function abort() {
        finish(signal.reason);
      }
      const timer = setTimeout(() => finish(new Error("浏览器界面没有响应")), 10000);
      pending.set(id, finish);
      signal.addEventListener("abort", abort, { once: true });
      send("browser:tool-request", { id, method, args, sessionId: run.sessionId });
    });
  }
  function receive(message) {
    const finish = pending.get(message.id);
    if (finish) {
      finish(message.error ? new Error(message.error) : null, message.result);
    }
  }
  async function target(id, run) {
    await ask("wake", { id }, run);
    const deadline = Date.now() + 15000;
    while (true) {
      run.controller.signal.throwIfAborted();
      let contents;
      try {
        contents = page(id, run.sessionId);
      } catch {
        /* 新标签等待 webview 登记。 */
      }
      if (contents && !contents.isLoadingMainFrame()) {
        const state = track(contents);
        if (Date.now() - state.usedAt < 1500) {
          throw new Error("browser_user_active：用户正在操作这个页面，请停止控制");
        }
        run.pages.add(contents);
        return contents;
      }
      if (Date.now() > deadline) {
        throw new Error("页面尚未就绪，请检查标签后重试");
      }
      await delay(30, undefined, { signal: run.controller.signal });
    }
  }
  function command(contents, method, args = {}) {
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach("1.3");
    }
    return contents.debugger.sendCommand(method, args);
  }
  async function evaluate(contents, expression, signal) {
    const state = track(contents);
    if (!state.contextId) {
      const tree = await command(contents, "Page.getFrameTree");
      const context = await command(contents, "Page.createIsolatedWorld", {
        frameId: tree.frameTree.frame.id,
        worldName: "agentic-browser",
      });
      state.contextId = context.executionContextId;
    }
    signal.throwIfAborted();
    function abort() {
      void command(contents, "Runtime.terminateExecution").catch(() => {});
    }
    signal.addEventListener("abort", abort, { once: true });
    try {
      const result = await command(contents, "Runtime.evaluate", {
        expression,
        contextId: state.contextId,
        returnByValue: true,
        awaitPromise: true,
        timeout: 5000,
      });
      signal.throwIfAborted();
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description || result.exceptionDetails.text,
        );
      }
      return result.result.value;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  async function perform(method, args, run) {
    const signal = run.controller.signal;
    signal.throwIfAborted();
    if (method === "tabs") {
      return ask("tabs", {}, run);
    }
    if (method === "open" || method === "goto") {
      if (typeof args.url !== "string" || !allowedURL(args.url)) {
        throw new Error("只允许 HTTP/HTTPS 网页，不能打开 agentic 自己的地址");
      }
    }
    if (method === "open") {
      const tab = await ask("open", args, run);
      await target(tab.id, run);
      return tab;
    }
    if (method === "goto" || method === "focus" || method === "close") {
      await ask("check", { id: args.id }, run);
      // 空白或休眠标签也可以导航、切换和关闭，不要求先有网页实例。
      let existing;
      try {
        existing = page(args.id, run.sessionId);
      } catch {
        /* 界面会核对标签是否存在。 */
      }
      if (existing) {
        if (Date.now() - track(existing).usedAt < 1500) {
          throw new Error("browser_user_active：用户正在操作这个页面，请停止控制");
        }
        run.pages.add(existing);
      }
      const result = await ask(method, args, run);
      if (method === "goto") {
        await target(args.id, run);
      }
      return result;
    }
    const contents = await target(args.id, run);
    signal.throwIfAborted();
    if (method === "evaluate") {
      return evaluate(contents, args.expression, signal);
    }
    if (method === "screenshot") {
      await ask("focus", { id: args.id }, run);
      // Chromium 直接绘制截图，避免后台 webview 的控件图层缺失。
      const { data } = await command(contents, "Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      const image = electron.nativeImage.createFromDataURL(`data:image/png;base64,${data}`);
      const size = image.getSize();
      return {
        png: data,
        width: size.width,
        height: size.height,
        url: contents.getURL(),
      };
    }
    const state = track(contents);
    state.input = true;
    try {
      switch (method) {
        case "act": {
          if (!["click", "fill", "select", "scroll"].includes(args.kind)) {
            throw new Error("无效的 Jev 浏览器操作");
          }
          if (args.kind === "fill" && typeof args.text !== "string") {
            throw new Error("输入内容必须是字符串");
          }
          // 新鲜度检查、节点解析、遮挡检查紧邻实际输入；整个任务共用用户接管状态。
          const point = await evaluate(contents, args.expression, signal);
          signal.throwIfAborted();
          if (point.stale) {
            return point;
          }
          if (args.kind === "select") {
            return { ok: true };
          }
          if (args.kind === "scroll") {
            await command(contents, "Input.dispatchMouseEvent", {
              type: "mouseWheel",
              x: point.x,
              y: point.y,
              deltaX: 0,
              deltaY: args.delta,
            });
            return { ok: true };
          }
          for (const type of ["mousePressed", "mouseReleased"]) {
            signal.throwIfAborted();
            await command(contents, "Input.dispatchMouseEvent", {
              type,
              x: point.x,
              y: point.y,
              button: "left",
              clickCount: 1,
            });
          }
          if (args.kind === "fill") {
            signal.throwIfAborted();
            await command(contents, "Input.dispatchKeyEvent", {
              type: "keyDown",
              key: "a",
              code: "KeyA",
              commands: ["selectAll"],
              modifiers: process.platform === "darwin" ? 4 : 2,
            });
            await command(contents, "Input.dispatchKeyEvent", {
              type: "keyUp",
              key: "a",
              code: "KeyA",
              modifiers: process.platform === "darwin" ? 4 : 2,
            });
            signal.throwIfAborted();
            await command(contents, "Input.insertText", { text: args.text });
          }
          return { ok: true };
        }
        case "click": {
          if (!Number.isFinite(args.x) || !Number.isFinite(args.y) || args.x < 0 || args.y < 0) {
            throw new Error("click(x,y) 需要非负视口坐标");
          }
          const point = { x: args.x, y: args.y, button: "left", clickCount: 1 };
          await command(contents, "Input.dispatchMouseEvent", { type: "mousePressed", ...point });
          await command(contents, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point });
          break;
        }
        case "press": {
          const key = keys[args.key];
          if (!key) {
            throw new Error(
              `不支持按键 ${args.key}，可用：${Object.keys(keys).join(", ")}；文字用 type(text)`,
            );
          }
          const input = {
            key: args.key === "Space" ? " " : args.key,
            code: key[0],
            windowsVirtualKeyCode: key[1],
          };
          await command(contents, "Input.dispatchKeyEvent", { type: "keyDown", ...input });
          await command(contents, "Input.dispatchKeyEvent", { type: "keyUp", ...input });
          break;
        }
        case "type":
          if (typeof args.text !== "string") {
            throw new Error("type(text) 需要字符串");
          }
          await command(contents, "Input.insertText", { text: args.text });
          break;
        default:
          throw new Error(`未知浏览器操作：${method}`);
      }
      return { ok: true };
    } finally {
      state.input = false;
    }
  }
  function execute(message) {
    if (typeof message.sessionId !== "string" || !message.sessionId) {
      return Promise.reject(new Error("浏览器工具缺少对话 ID"));
    }
    let run = runs.get(message.runId);
    if (!run) {
      run = {
        sessionId: message.sessionId,
        controller: new AbortController(),
        pages: new Set(),
        queue: Promise.resolve(),
      };
      runs.set(message.runId, run);
    }
    if (run.sessionId !== message.sessionId) {
      return Promise.reject(new Error("浏览器运行不能切换对话"));
    }
    // 即使脚本使用 Promise.all，同一次执行里的网页操作也按提交顺序执行。
    const result = run.queue.then(() => perform(message.method, message.args, run));
    run.queue = result.catch(() => {});
    return result;
  }
  function cancel(runId) {
    const run = runs.get(runId);
    if (run) {
      run.controller.abort(new Error("浏览器脚本已结束或取消；已发生的操作不会撤销"));
      runs.delete(runId);
    }
  }
  return { execute, cancel, receive, track };
}
