import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, chatClient } from "../../server/tests/chat-client.js";
import { message } from "../../server/ai/index.js";

// 先启动 npm run dev；测试只使用本地 Worker 与临时数据库。
const worker = process.env.RELAY_TEST_URL || "http://127.0.0.1:8787";
const key = process.env.RELAY_TEST_SECRET || "local-test-relay-secret-12345678";
test("真实 Worker：授权、双端同步、图片中转、会话隔离、断线恢复和撤销", async (t) => {
  let requests = 0;
  const f = await fixture(t, async () => {
    requests++;
    return { output: [message("远程回答", "output_text", "assistant")] };
  });
  const id = await f.newSession();
  const other = await f.newSession();
  assert.equal((await fetch(`${worker}/rooms`, { method: "POST" })).status, 401);
  const registered = await f.request(`/api/sessions/${id}/remote`, "POST", { url: worker, key });
  assert.equal(registered.status, 201, await registered.clone().text());
  const { url } = await registered.json();
  const link = new URL(url);
  const root = link.origin + link.pathname;
  const unauthorized = await fetch(`${root}/api/status`);
  assert.equal(unauthorized.status, 401);
  const auth = await fetch(`${root}/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: link.hash.slice(1) }),
  });
  assert.equal(auth.status, 200);
  const cookie = auth.headers.get("set-cookie").split(";")[0];
  const remote = await chatClient(t, root.replace("http", "ws") + "/ws", { headers: { cookie } });
  const connected = await remote.wait("connected");
  assert.equal(connected.session_id, id);
  const snapshot = await remote.subscribe(id);
  assert.equal(snapshot.messages.length, 0);
  const local = await f.connect();
  await local.subscribe(id);
  const runId = remote.command("send", id, { text: "来自远程" });
  await remote.wait("run.finished", (packet) => packet.run_id === runId);
  await local.wait("run.finished", (packet) => packet.run_id === runId);
  assert.equal(requests, 1);
  const bad = remote.command("send", other, { text: "禁止" });
  assert.equal(
    (await remote.wait("request.rejected", (packet) => packet.request_id === bad)).status,
    403,
  );
  const rejected = await fetch(`${root}/api/sessions/${other}/messages`, { headers: { cookie } });
  assert.equal(rejected.status, 403);
  assert.match((await rejected.json()).error, /未授权/);
  for (const route of ["/api/config", "/api/sessions", `/api/sessions/${id}/remote`]) {
    const response = await fetch(root + route, { headers: { cookie } });
    assert.equal(response.status, 403);
  }
  const page = await fetch(`${root}/api/sessions/${id}/messages`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.equal((await page.json()).messages.length, 2);
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  // 跨多个 WS 数据块上传，验证不是把大图塞进聊天帧。
  const bytes = Buffer.alloc(180 * 1024);
  Buffer.from(png.split(",")[1], "base64").copy(bytes);
  const image = await fetch(`${root}/api/sessions/${id}/images`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ image: `data:image/png;base64,${bytes.toString("base64")}` }),
  });
  assert.equal(image.status, 201, await image.clone().text());
  const imageURL = (await image.json()).url;
  const downloaded = await fetch(`${root}/api/sessions/${id}/images/${path.basename(imageURL)}`, {
    headers: { cookie },
  });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  const forbidden = await fetch(`${root}/api/sessions/${id}/images`, {
    method: "POST",
    headers: { cookie, origin: "https://evil.example", "content-type": "application/json" },
    body: JSON.stringify({ image: png }),
  });
  assert.equal(forbidden.status, 403);
  remote.socket.terminate();
  const another = await chatClient(t, root.replace("http", "ws") + "/ws", { headers: { cookie } });
  await another.wait("connected");
  assert.equal((await another.subscribe(id)).messages.length, 2);
  const disabled = await f.request(`/api/sessions/${id}/remote`, "DELETE");
  assert.equal(disabled.status, 200, await disabled.clone().text());
  await delay(50);
  assert.equal((await fetch(`${root}/api/status`, { headers: { cookie } })).status, 404);
  assert.equal(f.runtime.db.prepare("SELECT COUNT(*) n FROM remote_sessions").get().n, 0);
  const pageResponse = await fetch(root);
  assert.equal(pageResponse.status, 200);
  assert.equal(pageResponse.redirected, false);
});

test("本地服务重启自动连接原房间，远程页面不换链接", async (t) => {
  const f = await fixture(t, async () => ({
    output: [message("重连成功", "output_text", "assistant")],
  }));
  const id = await f.newSession();
  const response = await f.request(`/api/sessions/${id}/remote`, "POST", { url: worker, key });
  assert.equal(response.status, 201);
  const link = new URL((await response.json()).url);
  const root = link.origin + link.pathname;
  const auth = await fetch(`${root}/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: link.hash.slice(1) }),
  });
  const cookie = auth.headers.get("set-cookie").split(";")[0];
  const remote = await chatClient(t, root.replace("http", "ws") + "/ws", { headers: { cookie } });
  await remote.wait("connected");
  await remote.subscribe(id);
  const marker = remote.packets.length;
  await f.runtime.close();
  await remote.wait("remote.status", (packet) => packet.online === false, marker);
  const offline = await fetch(`${root}/api/status`, { headers: { cookie } });
  assert.equal(offline.status, 503);
  const { createServer } = await import("../../server/index.js");
  const resumed = createServer({ p: f.p, config: f.config });
  try {
    const origin = await resumed.listen();
    await remote.wait("connected", () => true, marker);
    const packets = await remote.run(id, "重启后发送");
    assert.equal(packets.find((packet) => packet.type === "run.finished").status, "completed");
    const snapshot = await remote.subscribe(id);
    assert.equal(snapshot.messages.length, 2);
    await fetch(`${origin}/api/sessions/${id}/remote`, { method: "DELETE", headers: f.headers });
  } finally {
    await resumed.close();
  }
});
