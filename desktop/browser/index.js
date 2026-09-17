import { app, dialog, ipcMain, session, shell, webContents } from "electron";
import fs from "node:fs";
import path from "node:path";
import { loadSettings, saveSettings } from "./settings.js";
import { setupDownloads } from "./downloads.js";
import { setupPermissions } from "./permissions.js";
import { setupPageMenu } from "./menu.js";
import { browserShortcut } from "./shortcuts.js";
import { profiles, readBookmarks, importCookies } from "./chrome.js";
import { isWebURL } from "./url.js";
export { isWebURL } from "./url.js";

export function setupBrowser(getWindow, { node, core }) {
  const browsing = session.fromPartition("persist:agentic-browser");
  const settings = loadSettings();
  const tabs = new Map();
  let visible = false;
  let importing = false;
  function send(channel, data) {
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send(channel, data);
    }
  }
  function check(event) {
    if (event.sender !== getWindow()?.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("无效的桌面请求");
    }
  }
  function tabId(contents) {
    for (const [id, contentsId] of tabs) {
      if (contentsId === contents.id) {
        return id;
      }
    }
    return "";
  }
  function page(id) {
    const contentsId = tabs.get(id);
    if (!contentsId) {
      throw new Error("页面尚未加载");
    }
    const contents = webContents.fromId(contentsId);
    if (!contents || contents.isDestroyed() || contents.session !== browsing) {
      throw new Error("页面尚未加载");
    }
    return contents;
  }
  const downloads = setupDownloads(browsing, send, settings);
  const answerAuth = setupPermissions(browsing, getWindow, send, settings);
  ipcMain.handle("browser:state", (event) => {
    check(event);
    return {
      settings,
      downloads: downloads.list(),
      importSupported: process.platform === "darwin",
    };
  });
  ipcMain.handle("browser:visible", (event, value) => {
    check(event);
    visible = value === true;
  });
  ipcMain.handle("browser:register", (event, id, contentsId) => {
    check(event);
    if (contentsId === null) {
      tabs.delete(id);
      return;
    }
    const contents = webContents.fromId(contentsId);
    if (!contents || contents.session !== browsing || contents.hostWebContents !== event.sender) {
      throw new Error("页面不属于当前窗口");
    }
    tabs.set(id, contentsId);
  });
  ipcMain.handle("browser:open-external", (event, url) => {
    check(event);
    if (!isWebURL(url)) {
      throw new Error("只支持 HTTP 或 HTTPS 地址");
    }
    return shell.openExternal(url);
  });
  ipcMain.handle("browser:download-action", (event, action, id) => {
    check(event);
    switch (action) {
      case "cancel":
        return downloads.cancel(id);
      case "reveal":
        return downloads.reveal(id);
      case "clear":
        return downloads.clear();
      default:
        throw new Error("下载操作无效");
    }
  });
  ipcMain.handle("browser:page-action", async (event, id, action) => {
    check(event);
    const contents = page(id);
    switch (action) {
      case "devtools":
        contents.openDevTools({ mode: "detach" });
        return;
      case "print":
        return new Promise((resolve, reject) =>
          contents.print({}, (ok, reason) => {
            if (ok || reason === "Print job canceled") {
              resolve();
            } else {
              reject(new Error(reason || "打印未完成"));
            }
          }),
        );
      case "screenshot": {
        const result = await dialog.showSaveDialog(getWindow(), {
          title: "保存网页截图",
          defaultPath: path.join(
            settings.downloadDirectory || app.getPath("downloads"),
            `网页截图-${Date.now()}.png`,
          ),
          filters: [{ name: "PNG 图片", extensions: ["png"] }],
        });
        if (result.canceled) {
          return;
        }
        const image = await contents.capturePage();
        fs.writeFileSync(result.filePath, image.toPNG());
        return result.filePath;
      }
      default:
        throw new Error("页面操作无效");
    }
  });
  ipcMain.handle("browser:settings", (event, patch) => {
    check(event);
    if (Object.keys(patch).some((key) => !["searchEngine", "downloadDirectory"].includes(key))) {
      throw new Error("设置字段无效");
    }
    if (patch.searchEngine !== undefined) {
      if (
        typeof patch.searchEngine !== "string" ||
        !isWebURL(patch.searchEngine) ||
        !patch.searchEngine.includes("{query}")
      ) {
        throw new Error("搜索网址必须包含 {query}");
      }
    }
    if (patch.downloadDirectory !== undefined) {
      if (
        typeof patch.downloadDirectory !== "string" ||
        (patch.downloadDirectory && !fs.statSync(patch.downloadDirectory).isDirectory())
      ) {
        throw new Error("下载目录不存在");
      }
    }
    Object.assign(settings, patch);
    saveSettings(settings);
    return settings;
  });
  ipcMain.handle("browser:choose-directory", async (event) => {
    check(event);
    const result = await dialog.showOpenDialog(getWindow(), {
      title: "选择下载目录",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("browser:revoke-permission", (event, key) => {
    check(event);
    delete settings.permissions[key];
    saveSettings(settings);
    return settings;
  });
  ipcMain.handle("browser:clear-data", async (event, kind) => {
    check(event);
    if (kind === "cache") {
      await browsing.clearCache();
    } else if (kind === "logins") {
      await browsing.clearStorageData();
      await browsing.clearAuthCache();
    } else {
      throw new Error("清理类型无效");
    }
  });
  ipcMain.handle("browser:auth-answer", (event, answer) => {
    check(event);
    answerAuth(answer);
  });
  ipcMain.handle("browser:chrome-profiles", (event) => {
    check(event);
    return profiles();
  });
  ipcMain.handle("browser:import-chrome", async (event, profile, kind) => {
    check(event);
    if (importing) {
      throw new Error("正在导入，请稍候");
    }
    importing = true;
    try {
      if (kind === "bookmarks") {
        return { bookmarks: readBookmarks(profile) };
      }
      if (kind === "cookies") {
        return await importCookies(browsing, node, core, profile);
      }
      throw new Error("导入类型无效");
    } finally {
      importing = false;
    }
  });
  function shortcuts(contents, host) {
    contents.on("before-input-event", (event, input) => {
      if (host && !visible) {
        return;
      }
      const command = browserShortcut(input);
      const id = tabId(contents);
      if (!command || (!host && !id)) {
        return;
      }
      event.preventDefault();
      send("browser:command", { command, tabId: id });
    });
  }
  app.on("web-contents-created", (_event, contents) => {
    if (contents.session !== browsing) {
      return;
    }
    shortcuts(contents, false);
    contents.once("destroyed", () => {
      const id = tabId(contents);
      if (id) {
        tabs.delete(id);
      }
    });
    function allowed(url) {
      if (url === "about:blank") {
        return true;
      }
      if (!isWebURL(url)) {
        return false;
      }
      const window = getWindow();
      if (!window || window.isDestroyed()) {
        return false;
      }
      const hostURL = window.webContents.getURL();
      return !isWebURL(hostURL) || new URL(url).origin !== new URL(hostURL).origin;
    }
    function guard(event, url) {
      if (!allowed(url)) {
        event.preventDefault();
      }
    }
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    contents.setWindowOpenHandler(({ url, disposition, postBody }) => {
      if (!allowed(url)) {
        return { action: "deny" };
      }
      // 带窗口特征的登录弹窗保留 opener；POST 表单也保留 Chromium 原生提交。
      if (disposition === "new-window" || postBody || url === "about:blank") {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            title: "agentic",
            autoHideMenuBar: true,
            webPreferences: {
              partition: "persist:agentic-browser",
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
            },
          },
        };
      }
      send("browser:open-tab", {
        url,
        background: disposition === "background-tab",
        openerId: tabId(contents),
      });
      return { action: "deny" };
    });
    setupPageMenu(contents, getWindow, send, tabId);
  });
  return {
    bindHost(contents) {
      shortcuts(contents, true);
    },
  };
}
