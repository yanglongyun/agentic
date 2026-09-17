import { app, BrowserWindow, dialog, Menu, session } from "electron";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setupBrowser, isWebURL } from "./browser/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
app.setName("agentic");
// 浏览器资料独立存放；后端继续使用原来的 agentic 配置和数据库。
app.setPath(
  "userData",
  process.env.AGENT_DESKTOP_HOME || path.join(app.getPath("appData"), "agentic-desktop"),
);

let child;
let window;
let origin;
let quitting = false;
let stopped = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) {
        window.restore();
      }
      window.show();
      window.focus();
    }
  });

  app.on("before-quit", (event) => {
    if (!child || stopped) {
      return;
    }
    event.preventDefault();
    if (quitting) {
      return;
    }
    quitting = true;
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      app.quit();
    });
    if (child.connected) {
      child.send({ type: "shutdown" });
    } else {
      child.kill();
    }
  });
  app.on("window-all-closed", () => app.quit());
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      dialog.showErrorBox("agentic 启动失败", error.message);
      app.quit();
    });
}

async function start() {
  const data = app.getPath("userData");
  fs.mkdirSync(data, { recursive: true });
  const portFile = path.join(data, "port.json");
  let port = 0;
  if (fs.existsSync(portFile)) {
    const saved = JSON.parse(fs.readFileSync(portFile, "utf8"));
    if (Number.isInteger(saved.port) && saved.port > 1024 && saved.port < 65536) {
      port = saved.port;
    }
  }
  let node;
  let core;
  if (app.isPackaged) {
    core = path.join(process.resourcesPath, "core");
    node = path.join(
      process.resourcesPath,
      "runtime",
      process.platform === "win32" ? "node.exe" : "node",
    );
  } else {
    core = root;
    node = process.env.AGENT_NODE;
    if (!node) {
      throw new Error("请使用 npm run app 启动桌面客户端");
    }
  }
  const log = fs.openSync(path.join(data, "server.log"), "a", 0o600);
  child = spawn(node, [path.join(core, "desktop/server.js"), String(port)], {
    cwd: app.getPath("home"),
    env: process.env,
    stdio: ["ignore", log, log, "ipc"],
  });
  fs.closeSync(log);
  child.once("exit", (code) => {
    stopped = true;
    if (!quitting) {
      dialog.showErrorBox("agentic", `本地服务已退出（${code}），请重新启动客户端。`);
      app.quit();
    }
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待本地服务启动超时")), 15000);
    child.once("message", (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      stopped = true;
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("本地服务启动失败，请查看桌面数据目录中的 server.log"));
    });
  });
  origin = ready.origin;
  fs.writeFileSync(portFile, JSON.stringify({ port: Number(new URL(origin).port) }));

  // 用现有登录接口建立宿主会话，Cookie 与外部网页的分区隔离。
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: ready.token }),
  });
  if (!response.ok) {
    throw new Error("本地服务登录失败");
  }
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const separator = cookie.indexOf("=");
  const hostSession = session.fromPartition("persist:agentic-ui");
  await hostSession.cookies.set({
    url: origin,
    name: cookie.slice(0, separator),
    value: cookie.slice(separator + 1),
    httpOnly: true,
    sameSite: "strict",
    path: "/",
  });

  const browser = setupBrowser(() => window, { node, core });
  window = new BrowserWindow({
    title: "agentic",
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    webPreferences: {
      partition: "persist:agentic-ui",
      preload: path.join(root, "desktop/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });
  browser.bindHost(window.webContents);
  window.webContents.on("will-attach-webview", (event, preferences, params) => {
    if (
      (params.src !== "about:blank" && !isWebURL(params.src)) ||
      params.partition !== "persist:agentic-browser"
    ) {
      event.preventDefault();
      return;
    }
    delete preferences.preload;
    preferences.nodeIntegration = false;
    preferences.contextIsolation = true;
    preferences.sandbox = true;
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) {
      event.preventDefault();
      if (isWebURL(url)) {
        window.webContents.send("browser:open-tab", { url, background: false });
      }
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebURL(url)) {
      window.webContents.send("browser:open-tab", { url, background: false });
    }
    return { action: "deny" };
  });
  window.once("ready-to-show", () => window.show());
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu", label: "agentic" }] : []),
      { role: "editMenu", label: "编辑" },
      { role: "viewMenu", label: "视图" },
      { role: "windowMenu", label: "窗口" },
    ]),
  );
  await window.loadURL(origin);
}
