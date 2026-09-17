import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import runTool from "../agent/runner.js";

async function fixture(t, respond) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-browser-test-"));
  const child = fork(new URL("./browser-child.js", import.meta.url), {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const exited = once(child, "exit");
  const waiting = new Map();
  child.on("message", async (message) => {
    if (message.type === "test:result") {
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
    if (message.type === "browser:request") {
      const result = await respond(message, child);
      if (result !== undefined && child.connected) {
        child.send({ type: "browser:result", runId: message.runId, id: message.id, ...result });
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
  return { run, child, directory };
}

test(
  "浏览器脚本经过 runner、线程和 IPC，参数只使用 summary/code",
  { timeout: 10000 },
  async (t) => {
    const calls = [];
    const f = await fixture(t, async (request) => {
      calls.push(request);
      if (request.method === "tabs") {
        return { result: [{ id: "tab-1", title: "test" }] };
      }
      assert.equal(request.args.id, "tab-1");
      assert.match(request.args.expression, /document.title/);
      assert.match(request.args.expression, /你好/);
      return { result: { title: "测试网页", text: "你好" } };
    });
    const result = await f.run(
      'const tabs = await browser.tabs(); const page = browser.page(tabs[0].id); return await page.evaluate((text) => ({ title: document.title, text }), "你好");',
    );
    assert.deepEqual(JSON.parse(result.result.text), { title: "测试网页", text: "你好" });
    assert.deepEqual(
      calls.map((call) => call.method),
      ["tabs", "evaluate"],
    );
    assert.equal(calls[0].runId, calls[1].runId);
  },
);

test("截图落文件，工具结果和返回文本不包含 base64", { timeout: 10000 }, async (t) => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const f = await fixture(t, async () => ({
    result: { png, width: 1, height: 1, url: "http://test" },
  }));
  const result = await f.run('return await browser.page("tab-1").screenshot();');
  assert.match(result.result.imageURL, /^\/api\/images\//);
  assert.deepEqual(result.images, [result.result.imageURL]);
  assert.doesNotMatch(JSON.stringify(result), /base64|iVBOR/);
  assert.deepEqual(
    await fs.readFile(path.join(f.directory, path.basename(result.result.imageURL))),
    Buffer.from(png, "base64"),
  );
});

test("脚本错误、同步死循环和取消后能继续调用，不污染后端", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, async (request, child) => {
    child.send({ type: "test:cancel", id: "abort" });
    return undefined;
  });
  const invalid = await f.run("return (;");
  assert.equal(invalid.result.failed, true);
  const thrown = await f.run('throw "脚本错误";');
  assert.equal(thrown.result.failed, true);
  assert.equal(thrown.result.text, "脚本错误");
  const empty = await f.run("throw null;");
  assert.equal(empty.result.failed, true);
  assert.equal(empty.result.text, "null");
  const loop = await f.run("while (true) {}");
  assert.equal(loop.result.failed, true);
  assert.match(loop.result.text, /timed out/);
  const cancelled = await f.run("return await browser.tabs();", "abort");
  assert.equal(cancelled.error, "测试取消");
  const next = await f.run("return 42;");
  assert.equal(next.result.text, "42");
});

test("并发脚本不争抢浏览器，取消释放占用", { timeout: 10000 }, async (t) => {
  let arrived;
  const requested = new Promise((resolve) => {
    arrived = resolve;
  });
  const f = await fixture(t, async () => {
    arrived();
  });
  const first = f.run("return await browser.tabs();", "first");
  await requested;
  const second = await f.run("return 2;");
  assert.equal(second.result.failed, true);
  assert.match(second.result.text, /另一个浏览器脚本/);
  f.child.send({ type: "test:cancel", id: "first" });
  await first;
  assert.equal((await f.run("return 3;")).result.text, "3");
});

test("没有桌面桥时明确返回不可用", async () => {
  const result = await runTool(
    {
      name: "browser",
      arguments: JSON.stringify({ summary: "测试", code: "return await browser.tabs();" }),
    },
    {},
  );
  assert.equal(result.failed, true);
  assert.match(result.text, /桌面 App/);
});
