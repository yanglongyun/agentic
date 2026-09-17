// code 在独立线程执行；JS 只组织操作，实际权限和输入由桌面原生程序处理。
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
function app(bundleId) {
  if (typeof bundleId !== "string" || !bundleId) {
    throw new Error("computer.app(bundleId) 需要应用的 bundleId");
  }
  return {
    bundleId,
    focus() {
      return request("focus", { bundleId });
    },
    state() {
      return request("state", { bundleId });
    },
    screenshot() {
      return request("screenshot", { bundleId });
    },
    click(elementOrX, y, button = "left", count = 1) {
      if (typeof elementOrX === "string") {
        return request("click", { bundleId, element: elementOrX });
      }
      return request("click", { bundleId, x: elementOrX, y, button, count });
    },
    action(element, action) {
      return request("action", { bundleId, element, action });
    },
    setValue(element, value) {
      return request("setValue", { bundleId, element, value });
    },
    press(key) {
      return request("press", { bundleId, key });
    },
    type(text) {
      return request("type", { bundleId, text });
    },
    scroll(x, y, dy, dx = 0) {
      return request("scroll", { bundleId, x, y, dy, dx });
    },
    drag(fromX, fromY, toX, toY) {
      return request("drag", { bundleId, fromX, fromY, toX, toY });
    },
  };
}
const computer = {
  apps() {
    return request("apps");
  },
  displays() {
    return request("displays");
  },
  permissions() {
    return request("permissions");
  },
  screenshot(displayId) {
    return request("screenshot", { displayId });
  },
  async open(bundleId) {
    await request("open", { bundleId });
    return app(bundleId);
  },
  app,
};
async function execute() {
  try {
    const context = vm.createContext({ computer });
    const script = new vm.Script(`async function run() {\n${workerData.code}\n}\nrun()`, {
      filename: "computer-tool.js",
    });
    const value = await script.runInContext(context, { timeout: 1000 });
    const text = JSON.stringify(value) ?? "执行完成（未返回值）";
    parentPort.postMessage({ type: "done", text });
  } catch (error) {
    parentPort.postMessage({ type: "done", error: String(error?.message || error) });
  }
}
void execute();
