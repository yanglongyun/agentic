import test from "node:test";
import assert from "node:assert/strict";
import { buildRows, mergeMessages, type RawMessage } from "../src/thread/thread";
import { checkAuth, logout, useAuth } from "../src/lib/auth";
import {
  send,
  retrySend,
  useThread,
  loadStatus,
  loadThreads,
  openThread,
  loadOlder,
  stopRun,
  receivePacket,
  init,
  dispose,
} from "../src/thread/store";
import { copyText } from "../src/lib/clipboard";

const call: RawMessage = {
  id: 1,
  item: { type: "function_call", call_id: "c1", name: "read", arguments: '{"path":"a.txt"}' },
};
const output: RawMessage = {
  id: 2,
  item: {
    type: "function_call_output",
    call_id: "c1",
    output: JSON.stringify({ success: true, text: '{"error":"ordinary file content"}' }),
  },
};
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("跨页调用与结果合并成一行，刷新保持稳定标识，文件 error 字段不表示工具失败", () => {
  const latest = buildRows([output]);
  const rows = buildRows(mergeMessages([call], [output]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, latest[0].key);
  assert.equal(rows[0].name, "read");
  assert.equal(rows[0].failed, false);
  assert.equal(rows[0].result, '{"error":"ordinary file content"}');
  const failed: RawMessage = {
    ...output,
    item: {
      type: "function_call_output",
      call_id: "c1",
      output: '{"success":false,"text":"退出码 1"}',
    },
  };
  assert.equal(buildRows([call, failed])[0].failed, true);
});
test("压缩记录按覆盖位置显示，加载更早历史后不重复", () => {
  const summaries = [{ id: 1, through_id: 2, summary: "摘要", created_at: 10 }];
  const last: RawMessage = {
    id: 3,
    item: { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
  };
  assert.deepEqual(
    buildRows([last], summaries).map((row) => row.key),
    ["compact:1", "message:3"],
  );
  assert.deepEqual(
    buildRows([call, output, last], summaries).map((row) => row.key),
    ["tool:c1", "compact:1", "message:3"],
  );
});
test("退出登录失败保持登录，身份检查区分网络故障与 401", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  useAuth.setState({ state: "in" });
  globalThis.fetch = async () => {
    throw new Error("网络断开");
  };
  assert.equal(await logout(), false);
  assert.equal(useAuth.getState().state, "in");
  await checkAuth();
  assert.equal(useAuth.getState().state, "error");
  assert.equal(useAuth.getState().error, "网络断开");
  globalThis.fetch = async () => json({ error: "unauthorized" }, 401);
  await checkAuth();
  assert.equal(useAuth.getState().state, "out");
  globalThis.fetch = async () => json({ ok: true });
  useAuth.setState({ state: "in" });
  assert.equal(await logout(), true);
  assert.equal(useAuth.getState().state, "out");
});
test("发送前检查失败不接管草稿、不发请求", (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => {
    throw new Error("不应该发送");
  };
  useThread.setState({ ready: true, busy: false, status: null, messages: [] });
  assert.equal(send("保留这段草稿"), false);
  assert.deepEqual(useThread.getState().messages, []);
  assert.equal(useThread.getState().busy, false);
});
test("状态和会话加载失败返回失败，保留已加载数据", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const threads = useThread.getState().threads;
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  assert.equal(await loadStatus(), false);
  assert.equal(await loadThreads(), false);
  assert.equal(useThread.getState().threads, threads);
});
test("复制等待剪贴板完成，拒绝时返回失败", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  t.after(() => {
    if (descriptor) {
      Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });
  let resolve: () => void = () => {};
  const pending = new Promise<void>((finish) => {
    resolve = finish;
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: () => pending } },
  });
  let finished = false;
  const copying = copyText("hello").then((value) => {
    finished = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  resolve();
  assert.equal(await copying, true);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    },
  });
  assert.equal(await copyText("hello"), false);
});

test("浏览器地址支持域名和本地端口，禁止脚本与本地文件导航", async () => {
  const { addressURL } = await import("../src/browser/store");
  assert.equal(addressURL("example.com"), "https://example.com/");
  assert.equal(addressURL("example.com:8080/path"), "https://example.com:8080/path");
  assert.equal(addressURL("localhost:8080"), "http://localhost:8080/");
  assert.equal(addressURL("127.0.0.1:9528"), "http://127.0.0.1:9528/");
  assert.equal(addressURL("https://example.com/path?q=1"), "https://example.com/path?q=1");
  assert.ok(addressURL("怎么做一个 Agent").startsWith("https://www.bing.com/search?q="));
  assert.throws(() => addressURL("javascript:alert(1)"));
  assert.throws(() => addressURL("file:///etc/passwd"));
  assert.throws(() => addressURL("data:text/html,hello"));
});

test("浏览器收起保留标签，后台打开不抢当前标签，关闭活动标签切到邻近标签", async () => {
  const { useBrowser, addTab, closeTab, toggleBrowser } = await import("../src/browser/store");
  useBrowser.setState({ open: false, tabs: [], activeId: "" });
  toggleBrowser();
  const first = useBrowser.getState().activeId;
  addTab("https://example.com", true);
  assert.equal(useBrowser.getState().activeId, first);
  const second = useBrowser.getState().tabs[1].id;
  toggleBrowser();
  assert.equal(useBrowser.getState().open, false);
  assert.equal(useBrowser.getState().tabs.length, 2);
  toggleBrowser();
  assert.equal(useBrowser.getState().activeId, first);
  closeTab(first);
  assert.equal(useBrowser.getState().activeId, second);
  closeTab(second);
  assert.equal(useBrowser.getState().tabs.length, 0);
});

test("浏览器新标签紧邻来源、排序保留实例标识、恢复关闭位置和网址", async () => {
  const {
    useBrowser,
    addTab,
    closeTab,
    reopenTab,
    reorderTabs,
    activateTab,
    updateTab,
    addressURL,
  } = await import("../src/browser/store");
  useBrowser.setState({ open: true, tabs: [], activeId: "", closed: [] });
  const first = addTab("https://first.test/");
  const second = addTab("https://second.test/");
  const linked = addTab("https://linked.test/", true, first);
  assert.deepEqual(
    useBrowser.getState().tabs.map((tab) => tab.id),
    [first, linked, second],
  );
  assert.equal(useBrowser.getState().activeId, second);
  updateTab(first, { ready: true, zoom: 150 });
  const instance = useBrowser.getState().tabs[0];
  reorderTabs(0, 2);
  assert.equal(useBrowser.getState().tabs[2], instance);
  activateTab(first);
  closeTab(first);
  assert.equal(useBrowser.getState().activeId, second);
  reopenTab();
  assert.equal(useBrowser.getState().activeId, first);
  assert.equal(useBrowser.getState().tabs[2].url, "https://first.test/");
  assert.equal(useBrowser.getState().tabs[2].ready, false);
  const blank = addTab();
  assert.equal(useBrowser.getState().tabs.find((tab) => tab.id === blank)?.awake, false);
  assert.equal(addressURL("a b", "https://search.test/?q={query}"), "https://search.test/?q=a%20b");
});

test("业务事件独立接管保存 ID，结束不 GET；快照恢复 live 增量和分页", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return json({ messages: [call], has_more: false });
  };
  await openThread("chat", true);
  receivePacket({
    type: "subscribed",
    session_id: "chat",
    snapshot: {
      session: { id: "chat", title: "", preview: "", running: true, updated_at: 1, created_at: 1 },
      messages: [output],
      has_more: true,
      compactions: [{ id: 1, through_id: 2, summary: "摘要", created_at: 1 }],
      status: { model: "test", model_ready: true, workdir: "/tmp" },
      run: { id: "run", status: "running", live: [] },
    },
  });
  assert.equal(useThread.getState().busy, true);
  receivePacket({
    type: "run.event",
    session_id: "chat",
    event: { type: "message", delta: "回答" },
  });
  const key = useThread.getState().messages.at(-1)?.key;
  receivePacket({
    type: "run.event",
    session_id: "chat",
    sequence: 1,
    event: {
      type: "message",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "回答" }],
      },
    },
  });
  receivePacket({
    type: "messages.saved",
    session_id: "chat",
    messages: [
      {
        id: 3,
        sequence: 1,
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "回答" }],
        },
        usage: { total_tokens: 12 },
        created_at: 2,
      },
    ],
  });
  receivePacket({
    type: "run.event",
    session_id: "chat",
    event: { type: "message", delta: "未提交" },
  });
  receivePacket({ type: "run.finished", session_id: "chat", status: "incomplete", error: "失败" });
  assert.equal(requests, 0);
  assert.equal(useThread.getState().busy, false);
  assert.equal(useThread.getState().messages.at(-1)?.key, key);
  assert.equal(useThread.getState().messages.at(-1)?.id, 3);
  assert.equal(useThread.getState().messages.length, 2);
  useThread.setState({ expanded: { "tool:c1": true } });
  await loadOlder();
  assert.equal(requests, 1);
  assert.equal(useThread.getState().expanded["tool:c1"], true);
  assert.equal(
    buildRows(useThread.getState().messages).filter((row) => row.kind === "tool").length,
    1,
  );
  receivePacket({
    type: "subscribed",
    session_id: "chat",
    snapshot: {
      session: { id: "chat", title: "", preview: "", running: true, updated_at: 2, created_at: 1 },
      messages: [output],
      has_more: false,
      compactions: [],
      status: { model: "test", model_ready: true, workdir: "/tmp" },
      run: {
        id: "run2",
        status: "running",
        live: [
          {
            id: 0,
            key: "live",
            streaming: true,
            item: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "恢复中的回答" }],
            },
          },
        ],
      },
    },
  });
  receivePacket({
    type: "run.event",
    session_id: "chat",
    event: { type: "message", delta: "继续" },
  });
  assert.equal(buildRows(useThread.getState().messages).at(-1)?.content, "恢复中的回答继续");
});

test("发送请求断线保留相同 ID，恢复订阅后再重发；切换会话不取消任务", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  const connections: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onopen: (() => void) | null = null;
    sent: Array<Record<string, unknown>> = [];
    constructor() {
      connections.push(this);
    }
    send(raw: string) {
      this.sent.push(JSON.parse(raw));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    event(value: Record<string, unknown>) {
      this.onmessage?.({ data: JSON.stringify(value) });
    }
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { href: "http://localhost/", pathname: "/" } },
  });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeSocket });
  globalThis.fetch = async (url) =>
    String(url).includes("/status")
      ? json({ model: "test", model_ready: true, workdir: "/tmp" })
      : json({ sessions: [] });
  t.after(() => {
    dispose();
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: originalWebSocket,
    });
  });
  await init();
  await openThread("socket-chat", true);
  const first = connections[0];
  first.event({ type: "connected" });
  first.event({ type: "remote.status", online: false });
  assert.equal(useThread.getState().online, true);
  const snapshot = {
    session: {
      id: "socket-chat",
      title: "",
      preview: "",
      running: false,
      updated_at: 1,
      created_at: 1,
    },
    messages: [],
    has_more: false,
    compactions: [],
    status: { model: "test", model_ready: true, workdir: "/tmp" },
    run: null,
  };
  first.event({ type: "subscribed", session_id: "socket-chat", snapshot });
  assert.equal(send("你好"), true);
  const sent = first.sent.find((packet) => packet.type === "send")!;
  assert.ok(sent.request_id);
  first.close();
  assert.equal(useThread.getState().busy, true);
  assert.equal(useThread.getState().online, false);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const second = connections[1];
  second.event({ type: "connected" });
  assert.equal(
    second.sent.some((packet) => packet.type === "send"),
    false,
  );
  second.event({ type: "subscribed", session_id: "socket-chat", snapshot });
  assert.equal(second.sent.find((packet) => packet.type === "send")?.request_id, sent.request_id);
  second.event({
    type: "request.accepted",
    session_id: "socket-chat",
    request_id: sent.request_id,
  });
  second.event({ type: "run.started", session_id: "socket-chat", run_id: sent.request_id });
  await Promise.resolve();
  const stopping = stopRun();
  assert.equal(second.sent.at(-1)?.type, "cancel");
  second.event({ type: "request.accepted", request_id: second.sent.at(-1)?.request_id });
  await stopping;
  await openThread("another-chat");
  assert.equal(second.sent.at(-1)?.type, "subscribe");
  assert.equal(second.sent.filter((packet) => packet.type === "cancel").length, 1);
});
