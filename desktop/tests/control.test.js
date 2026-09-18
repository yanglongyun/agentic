import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setupControl } from "../browser/control.js";

function fixture() {
  const contents = new EventEmitter();
  const debuggerAPI = new EventEmitter();
  const calls = [];
  let attached = false;
  debuggerAPI.isAttached = () => attached;
  debuggerAPI.attach = () => {
    attached = true;
  };
  debuggerAPI.sendCommand = async (method, args) => {
    calls.push({ method, args });
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "main" } } };
    }
    if (method === "Page.createIsolatedWorld") {
      return { executionContextId: 7 };
    }
    if (method === "Runtime.evaluate") {
      return { result: { value: { title: "test" } } };
    }
    if (method === "Input.dispatchMouseEvent") {
      contents.emit("before-mouse-event", {}, { type: "mouseDown" });
    }
    return {};
  };
  contents.debugger = debuggerAPI;
  contents.isLoadingMainFrame = () => false;
  const control = setupControl({
    page(id) {
      assert.equal(id, "page");
      return contents;
    },
    allowedURL(url) {
      return url === "https://example.com";
    },
    send(_channel, message) {
      queueMicrotask(() => control.receive({ id: message.id, result: { id: "page" } }));
    },
  });
  function execute(method, args = {}) {
    return control.execute({
      runId: "run",
      sessionId: "session-test",
      method,
      args: { id: "page", ...args },
    });
  }
  return { control, contents, execute, calls };
}

test("网页 JS 使用独立上下文，导航后重建，等待 Promise", async () => {
  const f = fixture();
  assert.deepEqual(await f.execute("evaluate", { expression: "document.title" }), {
    title: "test",
  });
  await f.execute("evaluate", { expression: "document.URL" });
  assert.equal(f.calls.filter((call) => call.method === "Page.createIsolatedWorld").length, 1);
  const evaluate = f.calls.find((call) => call.method === "Runtime.evaluate");
  assert.equal(evaluate.args.contextId, 7);
  assert.equal(evaluate.args.awaitPromise, true);
  assert.equal(evaluate.args.timeout, 5000);
  f.contents.emit("did-start-navigation", {}, "https://example.com", false, true);
  await f.execute("evaluate", { expression: "document.title" });
  assert.equal(f.calls.filter((call) => call.method === "Page.createIsolatedWorld").length, 2);
  f.control.cancel("run");
});

test("真实点击不当作用户接管；用户输入会停止同一脚本后续操作", async () => {
  const f = fixture();
  await f.execute("click", { x: 20, y: 30 });
  await f.execute("press", { key: "Enter" });
  assert.deepEqual(
    f.calls
      .filter((call) => call.method === "Input.dispatchMouseEvent")
      .map((call) => call.args.type),
    ["mousePressed", "mouseReleased"],
  );
  f.contents.emit("before-input-event", {}, { type: "keyDown" });
  await assert.rejects(
    f.execute("evaluate", { expression: "document.title" }),
    /browser_user_active/,
  );
  f.control.cancel("run");
});

test("无效 URL 在打开标签前拒绝，键鼠参数不接受非法数据", async () => {
  const f = fixture();
  await assert.rejects(f.execute("open", { url: "file:///private/test" }), /HTTP/);
  await assert.rejects(f.execute("click", { x: -1, y: 20 }), /坐标/);
  await assert.rejects(f.execute("press", { key: "unknown" }), /不支持按键/);
  f.control.cancel("run");
});

test("运行绑定业务对话，所有界面请求携带归属，跨对话页面在原生操作前拒绝", async () => {
  const requests = [];
  let touched = false;
  const control = setupControl({
    page() {
      touched = true;
      throw new Error("不应访问页面");
    },
    allowedURL() {
      return true;
    },
    send(_channel, message) {
      requests.push(message);
      queueMicrotask(() => control.receive({ id: message.id, error: "标签不属于当前对话" }));
    },
  });
  for (const method of ["evaluate", "click", "screenshot", "goto", "close", "focus"]) {
    await assert.rejects(
      control.execute({
        runId: "isolated",
        sessionId: "a",
        method,
        args: { id: "b-page", url: "https://example.com" },
      }),
      /不属于当前对话/,
    );
  }
  assert.equal(touched, false);
  assert.ok(requests.every((request) => request.sessionId === "a"));
  await assert.rejects(
    control.execute({ runId: "isolated", sessionId: "b", method: "tabs", args: {} }),
    /不能切换对话/,
  );
  await assert.rejects(control.execute({ runId: "missing", method: "tabs", args: {} }), /缺少对话/);
  control.cancel("isolated");
});

test("Jev 输入使用真实点击、全选和 insertText，过期页面不产生输入", async () => {
  const f = fixture();
  const send = f.contents.debugger.sendCommand;
  let stale = false;
  f.contents.debugger.sendCommand = async (method, args) => {
    if (method === "Runtime.evaluate") {
      f.calls.push({ method, args });
      return { result: { value: stale ? { stale: true } : { x: 25, y: 35 } } };
    }
    return send(method, args);
  };
  await f.execute("act", { kind: "fill", text: "Lisbon", expression: "prepareAction()" });
  assert.equal(f.calls.filter((call) => call.method === "Input.insertText")[0].args.text, "Lisbon");
  assert.deepEqual(f.calls.find((call) => call.args.commands)?.args.commands, ["selectAll"]);
  const before = f.calls.filter((call) => call.method.startsWith("Input.")).length;
  stale = true;
  assert.deepEqual(await f.execute("act", { kind: "click", expression: "prepareAction()" }), {
    stale: true,
  });
  assert.equal(f.calls.filter((call) => call.method.startsWith("Input.")).length, before);
  f.contents.emit("before-input-event", {}, { type: "keyDown" });
  await assert.rejects(
    f.execute("act", { kind: "click", expression: "prepareAction()" }),
    /browser_user_active/,
  );
  f.control.cancel("run");
});
