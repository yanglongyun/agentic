import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
async function start(t, port = 0) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-desktop-test-"));
  const child = spawn(process.execPath, [path.join(root, "desktop/server.js"), String(port)], {
    cwd: root,
    env: { ...process.env, AGENT_HOME: home },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.connected) {
      child.send({ type: "shutdown" });
    }
    await exited;
    await fs.rm(home, { recursive: true, force: true });
  });
  const [ready] = await once(child, "message", { signal: AbortSignal.timeout(10000) });
  return { child, ready, home, exited };
}

test("桌面子进程提供原有接口，主进程可以登录，退出时关闭端口", async (t) => {
  const { child, ready, home, exited } = await start(t);
  assert.equal(ready.type, "ready");
  assert.equal(new URL(ready.origin).hostname, "127.0.0.1");
  assert.equal((await fetch(ready.origin + "/healthz")).status, 200);
  assert.equal((await fetch(ready.origin + "/api/sessions")).status, 401);
  const response = await fetch(ready.origin + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: ready.token }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const sessions = await fetch(ready.origin + "/api/sessions", { headers: { cookie } });
  assert.deepEqual(await sessions.json(), { sessions: [] });
  const config = JSON.parse(await fs.readFile(path.join(home, "config.json"), "utf8"));
  assert.equal(config.api.token, ready.token);
  child.send({ type: "shutdown" });
  assert.equal((await exited)[0], 0);
  await assert.rejects(fetch(ready.origin + "/healthz"));
});

test("记住的桌面端口被占用时另选本地端口，父进程断开后退出", async (t) => {
  const first = await start(t);
  const second = await start(t, Number(new URL(first.ready.origin).port));
  assert.notEqual(first.ready.origin, second.ready.origin);
  second.child.disconnect();
  assert.equal((await second.exited)[0], 0);
  assert.equal((await fetch(first.ready.origin + "/healthz")).status, 200);
});
