import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import runTool from "../agent/runner.js";

async function fixture(t, respond) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-computer-test-"));
  const child = fork(new URL("./computer-child.js", import.meta.url), {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const exited = once(child, "exit");
  const waiting = new Map();
  const lifecycle = [];
  child.on("message", async (message) => {
    if (message.type === "test:result") {
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
    if (message.type === "computer:end" || message.type === "computer:cancel") {
      lifecycle.push(message.type);
    }
    if (message.type === "computer:request") {
      const result = await respond(message, child);
      if (result !== undefined && child.connected) {
        child.send({ type: "computer:result", runId: message.runId, id: message.id, ...result });
      }
    }
  });
  t.after(async () => {
    child.kill();
    await exited;
    await fs.rm(directory, { recursive: true, force: true });
  });
  function run(code, id = randomUUID()) {
    const result = new Promise((resolve) => waiting.set(id, resolve));
    child.send({ type: "test:run", id, code, directory });
    return result;
  }
  return { run, child, directory, lifecycle };
}

test("Mac 脚本经 runner/线程/IPC 调用应用，成功结束保留原生快照", { timeout: 10000 }, async (t) => {
  const calls = [];
  const f = await fixture(t, async (request) => {
    calls.push({ method: request.method, args: request.args });
    if (request.method === "apps") {
      return { result: [{ bundleId: "test.app" }] };
    }
    if (request.method === "state") {
      return { result: { elements: [{ id: "snapshot:1", role: "AXButton" }] } };
    }
    return { result: { ok: true } };
  });
  const state = await f.run(
    "const apps=await computer.apps(); const app=computer.app(apps[0].bundleId); await app.focus(); return await app.state();",
  );
  assert.equal(JSON.parse(state.result.text).elements[0].id, "snapshot:1");
  const clicked = await f.run(
    'const app=computer.app("test.app"); await app.click("snapshot:1"); await app.press("cmd+shift+s"); return await app.type("你好 👋");',
  );
  assert.equal(JSON.parse(clicked.result.text).ok, true);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["apps", "focus", "state", "click", "press", "type"],
  );
  assert.deepEqual(calls[3].args, { bundleId: "test.app", element: "snapshot:1" });
  assert.deepEqual(f.lifecycle, ["computer:end", "computer:end"]);
});

test("Mac 截图保留多屏坐标信息并落盘，结果不携带 Base64", { timeout: 10000 }, async (t) => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const bounds = { x: -1920, y: 0, width: 1920, height: 1080 };
  const f = await fixture(t, async () => ({
    result: { png, width: 1, height: 1, bounds, scale: 0.5, coordinates: "全局逻辑坐标" },
  }));
  const result = await f.run('return await computer.app("test.app").screenshot();');
  const image = JSON.parse(result.result.text);
  assert.deepEqual(image.bounds, bounds);
  assert.equal(image.scale, 0.5);
  assert.match(image.imageURL, /^\/api\/images\//);
  assert.equal(result.result.imageURL, image.imageURL);
  assert.doesNotMatch(JSON.stringify(result), /base64|iVBOR/);
  assert.deepEqual(
    await fs.readFile(path.join(f.directory, path.basename(image.imageURL))),
    Buffer.from(png, "base64"),
  );
});

test("系统停止能结束等待，死循环可中断，并释放下一次调用", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, async (request, child) => {
    child.send({ type: "computer:stopped", runId: request.runId });
  });
  const stopped = await f.run("return await computer.apps();");
  assert.equal(stopped.result.failed, true);
  assert.match(stopped.result.text, /用户停止/);
  const loop = await f.run("while(true) {}");
  assert.equal(loop.result.failed, true);
  assert.match(loop.result.text, /timed out/);
  const next = await f.run("return 42;");
  assert.equal(next.result.text, "42");
  assert.deepEqual(f.lifecycle, ["computer:cancel", "computer:cancel", "computer:end"]);
});

test(
  "模型无法通过 computer 对象调用权限授权接口；无桌面时明确失败",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, async () => {
      throw new Error("不应发出原生请求");
    });
    const denied = await f.run('return await computer.requestPermission("screen");');
    assert.equal(denied.result.failed, true);
    assert.match(denied.result.text, /not a function/);
    const unavailable = await runTool(
      {
        name: "computer",
        arguments: JSON.stringify({ summary: "检查", code: "return await computer.apps();" }),
      },
      {},
    );
    assert.equal(unavailable.failed, true);
    assert.match(unavailable.text, /桌面 App/);
  },
);
