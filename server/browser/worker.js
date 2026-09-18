// 每次工具调用一个执行线程；变量只在本次 code 内有效。
import vm from "node:vm";
import { parentPort, workerData } from "node:worker_threads";

let sequence = 0;
const pending = new Map();
function request(method, args = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: "request", id, method, args });
  });
}
parentPort.on("message", (message) => {
  const entry = pending.get(message.id);
  if (!entry) {
    return;
  }
  pending.delete(message.id);
  if (message.error) {
    entry.reject(new Error(message.error));
  } else {
    entry.resolve(message.result);
  }
});
function page(id) {
  if (typeof id !== "string" || !id) {
    throw new Error("browser.page(id) 需要 tabs() 或 open() 返回的标签 id");
  }
  return {
    id,
    evaluate(fn, argument) {
      if (typeof fn !== "function") {
        throw new Error("page.evaluate 需要函数，例如 () => document.title");
      }
      return request("evaluate", {
        id,
        expression: `(${fn.toString()})(${JSON.stringify(argument) ?? "undefined"})`,
      });
    },
    run(instructions) {
      return request("run", { id, instructions });
    },
    goto(url) {
      return request("goto", { id, url });
    },
    focus() {
      return request("focus", { id });
    },
    close() {
      return request("close", { id });
    },
    click(x, y) {
      return request("click", { id, x, y });
    },
    press(key) {
      return request("press", { id, key });
    },
    type(text) {
      return request("type", { id, text });
    },
    screenshot() {
      return request("screenshot", { id });
    },
  };
}
const browser = {
  tabs() {
    return request("tabs");
  },
  async open(url) {
    const result = await request("open", { url });
    return page(result.id);
  },
  page,
};
async function execute() {
  try {
    const context = vm.createContext({ browser });
    const script = new vm.Script(`async function run() {\n${workerData.code}\n}\nrun()`, {
      filename: "browser-tool.js",
    });
    const value = await script.runInContext(context, { timeout: 1000 });
    // 先转为 JSON，不能把页面句柄或函数作为工具结果交回。
    const text = JSON.stringify(value) ?? "执行完成（未返回值）";
    parentPort.postMessage({ type: "done", text });
  } catch (error) {
    parentPort.postMessage({ type: "done", error: String(error?.message || error) });
  }
}
void execute();
