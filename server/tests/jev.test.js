import test from "node:test";
import assert from "node:assert/strict";
import { requestBody, validateChoice } from "../browser/jev/ai.js";
import runJev from "../browser/jev/index.js";
import { defaults, validateConfig } from "../config.js";

function page(marker = "empty") {
  return {
    url: "https://example.com",
    title: "Search",
    text: marker,
    marker,
    actions: [
      { id: "1:fill", node: 1, kind: "fill", role: "searchbox", label: "Destination", value: "" },
      { id: "2:click", node: 2, kind: "click", role: "button", label: "Search", value: "" },
      { id: "WAIT", kind: "wait", label: "Wait for loading" },
    ],
  };
}
function answer(body, operation, target) {
  const answers = {};
  for (const [name, question] of Object.entries(body.questions)) {
    const options = Object.keys(question.criteria);
    let choice = options[0];
    if (name === "operation") {
      choice = operation;
    } else if (options.includes(target)) {
      choice = target;
    }
    const probabilities = {};
    for (const option of options) {
      probabilities[option] = option === choice ? 1 : 0;
    }
    answers[name] = { choice, confidence: 1, probabilities };
  }
  return Response.json({
    model: "jev-test",
    answers,
    usage: { input_tokens: 10, output_tokens: 3 },
  });
}
function config() {
  return {
    ...defaults(),
    url: "https://text.test/responses",
    key: "text-secret",
    model: "wrong-model",
    browser: { mode: "jev", jev_key: "jev-secret", jev_model: "jev-latest" },
  };
}

test("Jev 按页面提供动作，拒绝未知目标和畸形概率", () => {
  const body = requestBody("Search Lisbon", page(), [], "jev-test");
  assert.equal(body.questions.select_target, undefined);
  assert.deepEqual(Object.keys(body.questions.type_text_target.criteria), ["1:fill"]);
  assert.equal(body.questions.operation.instructions.goal, "Search Lisbon");
  assert.throws(() => validateChoice({ choice: "invented" }, { CLICK: "Click" }), /未提供/);
  assert.throws(
    () =>
      validateChoice(
        { choice: "CLICK", confidence: 1, probabilities: { CLICK: 0.2 } },
        { CLICK: "Click" },
      ),
    /无效/,
  );
});

test("Jev 输入复用现有 Responses 地址和 Key，model 使用独立入参，返回实际用量", async (t) => {
  let current = page();
  let decisions = 0;
  const executed = [];
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    if (url === "https://api.typesafe.ai/v1/systemone") {
      assert.equal(options.headers.authorization, "Bearer jev-secret");
      decisions++;
      return answer(body, decisions === 1 ? "TYPE_TEXT" : "DONE", "1:fill");
    }
    assert.equal(url, "https://text.test/responses");
    assert.equal(options.headers.authorization, "Bearer text-secret");
    assert.equal(body.model, "chosen-model");
    assert.deepEqual(body.tools, []);
    return Response.json({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: '{"text":"Lisbon"}' }] }],
      usage: { total_tokens: 20 },
    });
  });
  const result = await runJev("Search Lisbon", "tab", "chosen-model", config(), {
    signal: controller.signal,
    async request(method, args) {
      assert.equal(args.id, "tab");
      if (method === "act") {
        executed.push(args);
        current = page("Lisbon");
        return { ok: true };
      }
      return current;
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(executed.length, 1);
  assert.equal(executed[0].text, "Lisbon");
  assert.equal(result.actions.length, 1);
  assert.deepEqual(
    result.usage.map((item) => item.purpose),
    ["decision", "text", "decision"],
  );
  assert.equal(result.usage[1].usage.total_tokens, 20);
});

test("模型请求期间页面变化会重新观察，过期决定不执行", async (t) => {
  let current = page();
  let decisions = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    decisions++;
    const body = JSON.parse(options.body);
    if (decisions === 1) {
      current = page("changed");
      return answer(body, "CLICK", "2:click");
    }
    return answer(body, "DONE");
  });
  const result = await runJev("Read", "tab", "model", config(), {
    signal: new AbortController().signal,
    async request(method) {
      assert.equal(method, "evaluate");
      return current;
    },
  });
  assert.equal(decisions, 2);
  assert.equal(result.actions.length, 0);
  assert.equal(result.text, "changed");
});

test("不确定的浏览器变更失败不会重放", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) =>
    answer(JSON.parse(options.body), "CLICK", "2:click"),
  );
  await assert.rejects(
    runJev("Click", "tab", "model", config(), {
      signal: new AbortController().signal,
      async request(method) {
        if (method === "act") {
          calls++;
          throw new Error("导航中断，操作结果未知");
        }
        return page();
      },
    }),
    /结果未知/,
  );
  assert.equal(calls, 1);
});

test("停止会取消正在等待的 Jev 请求且不执行动作", async (t) => {
  const controller = new AbortController();
  t.mock.method(
    globalThis,
    "fetch",
    (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        controller.abort(new Error("用户停止"));
      }),
  );
  await assert.rejects(
    runJev("Click", "tab", "model", config(), {
      signal: controller.signal,
      async request(method) {
        assert.equal(method, "evaluate");
        return page();
      },
    }),
    /用户停止/,
  );
});

test("Jev 循环没有 50 轮上限", { timeout: 15000 }, async (t) => {
  let calls = 0;
  let current = page();
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls++;
    return answer(JSON.parse(options.body), calls > 51 ? "DONE" : "CLICK", "2:click");
  });
  const result = await runJev("Keep going", "tab", "model", config(), {
    signal: new AbortController().signal,
    async request(method) {
      if (method === "act") {
        current = page(String(calls));
        return { ok: true };
      }
      return current;
    },
  });
  assert.equal(result.actions.length, 51);
  assert.equal(calls, 52);
});

test("Jev 配置严格校验，缺密钥不能启用，未知字段不接受", () => {
  const settings = { ...defaults(), api: { listen: "127.0.0.1:0", token: "1234567890123456" } };
  validateConfig(settings);
  assert.throws(
    () => validateConfig({ ...settings, browser: { ...settings.browser, mode: "auto" } }),
    /mode/,
  );
  assert.throws(
    () => validateConfig({ ...settings, browser: { ...settings.browser, mode: "jev" } }),
    /API Key/,
  );
  assert.throws(
    () => validateConfig({ ...settings, browser: { ...settings.browser, fallback: true } }),
    /未知/,
  );
});
