import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { fixture } from "./chat-client.js";
import { message } from "../ai/index.js";
const answer = (text) => ({ output: [message(text, "output_text", "assistant")] });
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const tool = (id, name, args) => ({
  type: "function_call",
  call_id: id,
  name,
  arguments: JSON.stringify(args),
});

test("WS 鉴权、跨站拦截、HTTP 分页和页面路由", async (t) => {
  const f = await fixture(t, async () => answer("你好"));
  for (const headers of [{}, { ...f.headers, origin: "https://evil.example" }]) {
    const socket = new WebSocket(f.origin.replace("http", "ws") + "/api/chat", { headers });
    const error = await new Promise((resolve) => socket.once("error", resolve));
    assert.match(error.message, /401|403/);
  }
  assert.deepEqual(
    f.runtime.db
      .prepare("PRAGMA table_info(messages)")
      .all()
      .map((row) => row.name),
    ["id", "session_id", "item", "usage", "created_at"],
  );
  const id = await f.newSession();
  const chat = await f.connect();
  await chat.run(id, "你好");
  const page = await (await f.request(`/api/sessions/${id}/messages?limit=1`)).json();
  assert.equal(page.has_more, true);
  assert.equal(page.messages[0].item.role, "assistant");
  const previous = await (
    await f.request(`/api/sessions/${id}/messages?before=${page.messages[0].id}&limit=1`)
  ).json();
  assert.equal(previous.messages[0].item.role, "user");
  const renamed = await f.request(`/api/sessions/${id}`, "PATCH", { title: " 测试 " });
  assert.equal((await renamed.json()).title, "测试");
  const status = await (await f.request("/api/config")).json();
  assert.equal(status.key, undefined);
  assert.equal(status.api.token, undefined);
  assert.equal(
    (await f.request("/api/config", "PUT", { context_window: 100, compact_at: 100 })).status,
    400,
  );
  assert.equal(
    (await f.request("/api/config", "PUT", { context_window: 100, compact_at: 90 })).status,
    200,
  );
  for (const route of ["/", "/sessions/test", "/settings", "/login"]) {
    assert.equal((await fetch(f.origin + route)).status, 200);
  }
  await f.request(`/api/sessions/${id}`, "DELETE");
  await chat.wait("session.deleted");
  assert.equal(f.runtime.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 0);
});

test("九种 Agent 事件保留在 run.event，保存确认独立且只在提交后发送", async (t) => {
  let round = 0;
  const f = await fixture(t, async (_config, input) => {
    round++;
    if (round === 1) {
      return {
        output: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "计划" }] },
          tool("write", "write", { path: "a.txt", content: "hello" }),
        ],
        usage: { total_tokens: 42 },
      };
    }
    assert.equal(input.at(-1).type, "function_call_output");
    return answer("完成");
  });
  const chat = await f.connect();
  const id = await f.newSession();
  const packets = await chat.run(id, "开始");
  const events = packets
    .filter((packet) => packet.type === "run.event")
    .map((packet) => packet.event);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "message",
      "reasoning",
      "function_call",
      "usage",
      "function_call_output",
      "message",
      "usage",
      "done",
    ],
  );
  assert.ok(events.every((event) => !event.saved && !event.session));
  const saved = packets
    .filter((packet) => packet.type === "messages.saved")
    .flatMap((packet) => packet.messages);
  assert.equal(saved.length, 5);
  assert.equal(saved[2].usage.total_tokens, 42);
  assert.ok(saved.every((row) => row.id > 0));
  assert.equal(await fs.readFile(path.join(f.root, "a.txt"), "utf8"), "hello");
  assert.equal(packets.find((packet) => packet.type === "run.finished").status, "completed");
  const snapshot = await chat.subscribe(id);
  assert.equal(snapshot.run.status, "completed");
  assert.equal(snapshot.messages.length, 5);
});

test("两端同步；断开订阅不停止执行；重连快照包含未提交增量；请求去重", async (t) => {
  let release;
  let requests = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, async (_config, _input, _tools, _instructions, emit) => {
    requests++;
    emit({ type: "message", delta: "生成中" });
    await gate;
    return answer("最终回答");
  });
  const id = await f.newSession();
  const first = await f.connect();
  const second = await f.connect();
  await first.subscribe(id);
  await second.subscribe(id);
  const runId = first.command("send", id, { text: "问题" });
  await second.wait("run.event", (packet) => packet.event.delta === "生成中");
  first.socket.terminate();
  const next = await f.connect();
  const snapshot = await next.subscribe(id);
  assert.equal(snapshot.run.status, "running");
  assert.equal(snapshot.run.live[0].item.content[0].text, "生成中");
  next.command("send", id, { text: "问题", request_id: runId });
  assert.equal(
    (await next.wait("request.accepted", (packet) => packet.request_id === runId)).duplicate,
    true,
  );
  const conflict = next.command("send", id, { text: "不同内容", request_id: runId });
  assert.equal(
    (await next.wait("request.rejected", (packet) => packet.request_id === conflict)).status,
    409,
  );
  release();
  await second.wait("run.finished");
  await next.wait("run.finished");
  assert.equal(requests, 1);
  assert.equal(f.runtime.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 2);
});

test("同会话互斥，取消显式触发并等待模型清理", async (t) => {
  let aborted = false;
  const f = await fixture(t, async (_config, input, _tools, _instructions, emit, signal) => {
    if (input[0].content[0].text === "快") {
      return answer("完成");
    }
    emit({ type: "message", delta: "等待" });
    await new Promise((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          resolve();
        },
        { once: true },
      ),
    );
    return answer("不保存");
  });
  const chat = await f.connect();
  const id = await f.newSession();
  await chat.subscribe(id);
  chat.command("send", id, { text: "慢" });
  await chat.wait("run.event", (packet) => packet.event.delta);
  const conflict = chat.command("send", id, { text: "冲突" });
  assert.equal(
    (await chat.wait("request.rejected", (packet) => packet.request_id === conflict)).status,
    409,
  );
  assert.equal((await f.request(`/api/sessions/${id}`, "DELETE")).status, 409);
  const other = await f.newSession();
  await chat.run(other, "快");
  const cancel = chat.command("cancel", id);
  await chat.wait("request.accepted", (packet) => packet.request_id === cancel);
  const done = await chat.wait("run.finished", (packet) => packet.session_id === id);
  assert.equal(done.status, "aborted");
  await delay(30);
  assert.equal(aborted, true);
  assert.equal(
    f.runtime.db.prepare("SELECT COUNT(*) n FROM messages WHERE session_id = ?").get(id).n,
    1,
  );
});

test("压缩读取最新实际 usage；摘要入库后才继续请求；不回退更早 usage", async (t) => {
  let requests = 0;
  let compact = 0;
  const f = await fixture(
    t,
    async (_config, input, tools) => {
      if (!tools?.length) {
        compact++;
        return answer("测试摘要");
      }
      requests++;
      if (requests === 3) {
        assert.equal(f.runtime.db.prepare("SELECT COUNT(*) n FROM compactions").get().n, 1);
        assert.match(input[0].content[0].text, /测试摘要/);
      }
      if (requests <= 2) {
        return { ...answer("第一次"), usage: { total_tokens: 100 } };
      }
      return answer("后续无 usage");
    },
    { compact_at: 10, keep: 1 },
  );
  const chat = await f.connect();
  const id = await f.newSession();
  for (let index = 0; index < 4; index++) {
    await chat.run(id, `消息${index}`);
  }
  assert.equal(compact, 1);
  assert.equal(requests, 4);
  assert.equal(f.runtime.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 8);
  assert.ok(chat.packets.some((packet) => packet.type === "compaction.created"));
});

test("工具轮次使用最新 usage 连续压缩，后续失败保留已提交轮次", async (t) => {
  let round = 0;
  const f = await fixture(
    t,
    async (_config, _input, tools) => {
      if (!tools?.length) {
        return answer("摘要");
      }
      round++;
      if (round <= 4) {
        return {
          output: [tool(`call${round}`, "write", { path: `${round}.txt`, content: "ok" })],
          usage: { total_tokens: 100 },
        };
      }
      throw new Error("模型故障");
    },
    { compact_at: 10, keep: 1 },
  );
  const chat = await f.connect();
  const id = await f.newSession();
  const packets = await chat.run(id, "开始");
  assert.equal(packets.find((packet) => packet.type === "run.finished").status, "incomplete");
  assert.equal(f.runtime.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 9);
  assert.ok(f.runtime.db.prepare("SELECT COUNT(*) n FROM compactions").get().n >= 2);
});

test("不完整模型响应不保存完整块、不执行工具", async (t) => {
  const f = await fixture(t, async () => ({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [tool("w", "write", { path: "bad.txt", content: "no" })],
  }));
  const chat = await f.connect();
  const packets = await chat.run(await f.newSession(), "开始");
  assert.equal(packets.find((packet) => packet.type === "run.finished").status, "incomplete");
  assert.equal(
    packets.some((packet) => packet.type === "run.event" && packet.event.type === "function_call"),
    false,
  );
  assert.equal(f.runtime.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 1);
  await assert.rejects(fs.access(path.join(f.root, "bad.txt")));
});

test("事务失败无保存确认，失败状态持久化用于重连", async (t) => {
  const f = await fixture(t, async () => answer("答案"));
  const id = await f.newSession();
  const chat = await f.connect();
  f.runtime.db.exec(
    "CREATE TRIGGER reject_assistant BEFORE INSERT ON messages WHEN json_extract(NEW.item, '$.role') = 'assistant' BEGIN SELECT RAISE(ABORT, 'test failure'); END",
  );
  const packets = await chat.run(id, "开始");
  const saved = packets
    .filter((packet) => packet.type === "messages.saved")
    .flatMap((packet) => packet.messages);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].item.role, "user");
  const snapshot = await chat.subscribe(id);
  assert.equal(snapshot.run.status, "incomplete");
  assert.match(snapshot.run.error, /test failure/);
});

test("图片单独上传最多五张，归属校验，数据库和 WS 没有 base64，删除清理", async (t) => {
  const f = await fixture(t, async (_config, input) => {
    const images = input[0].content.filter((part) => part.type === "input_image");
    assert.equal(images.length, 5);
    assert.equal(images[0].image_url, png);
    return answer("看到了");
  });
  const id = await f.newSession();
  const other = await f.newSession();
  const urls = [];
  for (let index = 0; index < 5; index++) {
    const response = await f.request(`/api/sessions/${id}/images`, "POST", { image: png });
    assert.equal(response.status, 201);
    urls.push((await response.json()).url);
  }
  const chat = await f.connect();
  await chat.subscribe(id);
  for (const images of [null, "invalid", [...urls, urls[0]], [png]]) {
    const requestId = chat.command("send", id, { text: "看图", images });
    assert.equal(
      (await chat.wait("request.rejected", (packet) => packet.request_id === requestId)).status,
      400,
    );
  }
  const invalid = chat.command("send", other, { text: "偷图", images: [urls[0]] });
  assert.equal(
    (await chat.wait("request.rejected", (packet) => packet.request_id === invalid)).status,
    400,
  );
  const packets = await chat.run(id, "", urls);
  assert.equal(JSON.stringify(packets).includes("base64"), false);
  await chat.run(id, "再看一次");
  assert.equal(
    f.runtime.db.prepare("SELECT item FROM messages LIMIT 1").get().item.includes("base64"),
    false,
  );
  assert.equal(
    (await f.request(`/api/sessions/${other}/images/${path.basename(urls[0])}`)).status,
    404,
  );
  assert.equal(
    (await f.request(`/api/sessions/${id}/images/${path.basename(urls[0])}`)).status,
    200,
  );
  await f.request(`/api/sessions/${id}`, "DELETE");
  assert.deepEqual(await fs.readdir(f.p.images), []);
});

test("上传校验和上传记录写入失败清理文件", async (t) => {
  const f = await fixture(t, async () => answer("ok"));
  const id = await f.newSession();
  for (const image of [
    null,
    "data:image/png;base64,aGVsbG8=",
    png.replace("image/png", "image/jpeg"),
    "data:image/svg+xml;base64,PHN2Zy8+",
  ]) {
    assert.equal((await f.request(`/api/sessions/${id}/images`, "POST", { image })).status, 400);
  }
  const bytes = Buffer.alloc(10 * 1024 * 1024 + 1);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(
    (
      await f.request(`/api/sessions/${id}/images`, "POST", {
        image: `data:image/png;base64,${bytes.toString("base64")}`,
      })
    ).status,
    413,
  );
  f.runtime.db.exec(
    "CREATE TRIGGER reject_image BEFORE INSERT ON session_images BEGIN SELECT RAISE(ABORT, 'test failure'); END",
  );
  assert.equal((await f.request(`/api/sessions/${id}/images`, "POST", { image: png })).status, 500);
  assert.deepEqual(await fs.readdir(f.p.images), []);
});

test("工具图片保持标准 output，模型请求时还原 base64，历史重新读取仍可用", async (t) => {
  let round = 0;
  const f = await fixture(t, async (_config, input) => {
    round++;
    if (round === 1) {
      return { output: [tool("read-image", "read", { path: "sample.png" })] };
    }
    const output = input.find((item) => item.type === "function_call_output");
    assert.equal(output.output[1].image_url, png);
    return answer("看过了");
  });
  await fs.writeFile(path.join(f.root, "sample.png"), Buffer.from(png.split(",")[1], "base64"));
  const chat = await f.connect();
  const id = await f.newSession();
  const packets = await chat.run(id, "读图");
  assert.equal(JSON.stringify(packets).includes("base64"), false);
  await fs.unlink(path.join(f.root, "sample.png"));
  await chat.run(id, "继续");
  const output = f.runtime.db
    .prepare(
      "SELECT item FROM messages WHERE json_extract(item, '$.type') = 'function_call_output'",
    )
    .get();
  const image = JSON.parse(output.item).output[1].image_url;
  assert.equal((await f.request(`/api/sessions/${id}/images/${path.basename(image)}`)).status, 200);
});

test("服务重启后请求去重仍有效，不会再次调用模型", async (t) => {
  let requests = 0;
  const f = await fixture(t, async () => {
    requests++;
    return answer("完成");
  });
  const chat = await f.connect();
  const id = await f.newSession();
  const packets = await chat.run(id, "一次就好");
  const requestId = packets.find((packet) => packet.type === "request.accepted").request_id;
  await f.runtime.close();
  const { createServer } = await import("../index.js");
  const { chatClient } = await import("./chat-client.js");
  const resumed = createServer({ p: f.p, config: f.config });
  try {
    const origin = await resumed.listen();
    const next = await chatClient(t, origin.replace("http", "ws") + "/api/chat", {
      headers: f.headers,
    });
    await next.subscribe(id);
    next.command("send", id, { text: "一次就好", request_id: requestId });
    assert.equal((await next.wait("request.accepted")).duplicate, true);
    assert.equal(requests, 1);
  } finally {
    await resumed.close();
  }
});

test("取消半轮工具丢弃未提交块并清理图片文件", async (t) => {
  const f = await fixture(t, async () => ({
    output: [
      tool("image", "read", { path: "sample.png" }),
      tool("wait", "shell", { command: "sleep 30" }),
    ],
    usage: { total_tokens: 8 },
  }));
  await fs.writeFile(path.join(f.root, "sample.png"), Buffer.from(png.split(",")[1], "base64"));
  const chat = await f.connect();
  const id = await f.newSession();
  await chat.subscribe(id);
  chat.command("send", id, { text: "开始" });
  await chat.wait("run.event", (packet) => packet.event.type === "function_call_output");
  const cancel = chat.command("cancel", id);
  await chat.wait("request.accepted", (packet) => packet.request_id === cancel);
  assert.equal(f.runtime.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 1);
  assert.deepEqual(await fs.readdir(f.p.images), []);
  assert.equal(chat.packets.filter((packet) => packet.type === "messages.saved").length, 1);
});

test("旧 cancel 重发只确认，不取消后来开始的运行", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  let round = 0;
  const f = await fixture(t, async (_config, _input, _tools, _instructions, emit) => {
    round++;
    if (round === 2) {
      emit({ type: "message", delta: "正在生成" });
      await gate;
    }
    return answer("完成");
  });
  const chat = await f.connect();
  const id = await f.newSession();
  const first = await chat.run(id, "第一轮");
  const firstRun = first.find((packet) => packet.type === "run.started").run_id;
  const secondRun = chat.command("send", id, { text: "第二轮" });
  await chat.wait("run.event", (packet) => packet.event.delta === "正在生成");
  const cancel = chat.command("cancel", id, { run_id: firstRun });
  await chat.wait("request.accepted", (packet) => packet.request_id === cancel);
  assert.equal((await chat.subscribe(id)).run.id, secondRun);
  release();
  assert.equal(
    (await chat.wait("run.finished", (packet) => packet.run_id === secondRun)).status,
    "completed",
  );
});
