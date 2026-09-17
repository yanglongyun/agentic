import { app, globalShortcut, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export function setupComputer(getWindow, server) {
  const supported = process.platform === "darwin";
  const filename = path.join(app.getPath("userData"), "computer.json");
  let enabled = false;
  if (fs.existsSync(filename)) {
    enabled = JSON.parse(fs.readFileSync(filename, "utf8")).enabled === true;
  }
  let helper;
  let sequence = 0;
  let currentRun;
  let queue = Promise.resolve();
  const pending = new Map();
  const shortcut = "CommandOrControl+Shift+Escape";
  let shortcutRegistered = false;

  function check(event) {
    const contents = getWindow()?.webContents;
    if (event.sender !== contents || event.senderFrame !== contents?.mainFrame) {
      throw new Error("无效的桌面请求");
    }
  }
  function reset(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    if (helper) {
      const child = helper;
      helper = null;
      child.kill("SIGTERM");
    }
  }
  function start() {
    if (helper) {
      return helper;
    }
    if (!supported) {
      throw new Error("computer 工具目前仅支持 macOS");
    }
    let binary = fileURLToPath(new URL("../runtime/agentic-computer", import.meta.url));
    if (app.isPackaged) {
      binary = path.join(process.resourcesPath, "runtime/agentic-computer");
    }
    if (!fs.existsSync(binary)) {
      throw new Error("Mac 控制程序尚未构建，请运行 npm run app:prepare");
    }
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    helper = child;
    child.stdin.on("error", (error) => {
      if (helper === child) {
        reset(error);
      }
    });
    child.stderr.on("data", () => {});
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (helper !== child) {
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        reset(new Error("Mac 控制程序返回了无效数据"));
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) {
        return;
      }
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new Error(message.error));
      } else {
        entry.resolve(message.result);
      }
    });
    child.on("error", (error) => {
      if (helper === child) {
        reset(error);
      }
    });
    child.on("exit", () => {
      lines.close();
      if (helper === child) {
        helper = null;
        reset(new Error("Mac 控制程序已退出，请重新读取界面"));
      }
    });
    return child;
  }
  function request(method, args) {
    const child = start();
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      let timeout = 15000;
      if (method === "type") {
        timeout = 60000;
      }
      if (method === "requestPermission") {
        timeout = 120000;
      }
      const timer = setTimeout(() => reset(new Error("Mac 控制操作超时，请重新读取界面")), timeout);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, args }) + "\n", (error) => {
        if (error && helper === child) {
          reset(error);
        }
      });
    });
  }
  function publish() {
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send("computer:changed", { enabled });
    }
  }
  function saveEnabled(value) {
    enabled = value;
    fs.writeFileSync(filename, JSON.stringify({ enabled }, null, 2) + "\n");
    publish();
  }
  function stop() {
    const runId = currentRun;
    currentRun = null;
    saveEnabled(false);
    reset(new Error("Mac 控制已被用户停止"));
    if (runId && server.connected) {
      server.send({ type: "computer:stopped", runId }, () => {});
    }
  }
  async function state() {
    if (!supported) {
      return {
        supported: false,
        enabled: false,
        accessibility: false,
        screen: false,
        shortcut: false,
      };
    }
    const permissions = await request("permissions", {});
    return { supported, enabled, ...permissions, shortcut: shortcutRegistered };
  }
  if (supported) {
    shortcutRegistered = globalShortcut.register(shortcut, stop);
  }
  ipcMain.handle("computer:state", (event) => {
    check(event);
    return state();
  });
  ipcMain.handle("computer:enabled", async (event, value) => {
    check(event);
    if (!supported || typeof value !== "boolean") {
      throw new Error("Mac 控制设置无效");
    }
    if (!value) {
      stop();
    } else {
      saveEnabled(true);
    }
    return state();
  });
  ipcMain.handle("computer:permission", async (event, kind) => {
    check(event);
    if (kind !== "accessibility" && kind !== "screen") {
      throw new Error("权限类型无效");
    }
    await request("requestPermission", { kind });
    const pane = kind === "accessibility" ? "Privacy_Accessibility" : "Privacy_ScreenCapture";
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
    return state();
  });
  app.on("will-quit", () => {
    globalShortcut.unregister(shortcut);
    reset(new Error("客户端已退出"));
  });
  server.once("exit", () => reset(new Error("本地服务已退出")));
  return {
    execute(message) {
      if (!enabled) {
        return Promise.reject(new Error("Mac 控制未开启，请在设置 → Mac 控制中开启"));
      }
      if (currentRun && currentRun !== message.runId) {
        return Promise.reject(new Error("另一个 Mac 控制脚本正在执行"));
      }
      currentRun = message.runId;
      const allowed = [
        "permissions",
        "apps",
        "displays",
        "open",
        "focus",
        "state",
        "screenshot",
        "click",
        "action",
        "setValue",
        "press",
        "type",
        "scroll",
        "drag",
      ];
      if (!allowed.includes(message.method)) {
        return Promise.reject(new Error("不支持的 Mac 控制操作"));
      }
      const result = queue.then(() => {
        if (!enabled || currentRun !== message.runId) {
          throw new Error("Mac 控制已停止");
        }
        return request(message.method, message.args);
      });
      queue = result.catch(() => {});
      return result;
    },
    finish(runId) {
      if (currentRun === runId) {
        currentRun = null;
        if (pending.size > 0) {
          reset(new Error("脚本结束时仍有未等待的操作，请 await 所有操作"));
        }
      }
    },
    cancel(runId) {
      if (currentRun === runId) {
        currentRun = null;
        reset(new Error("Mac 控制已取消"));
      }
    },
  };
}
