import { app, dialog } from "electron";
import { randomUUID } from "node:crypto";
import { saveSettings } from "./settings.js";

export function setupPermissions(browsing, getWindow, send, settings) {
  const requests = new Map();
  browsing.setPermissionCheckHandler((_contents, permission, origin) => {
    if (["fullscreen", "clipboard-sanitized-write"].includes(permission)) {
      return true;
    }
    return settings.permissions[`${origin}|${permission}`] === true;
  });
  browsing.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (["fullscreen", "clipboard-sanitized-write"].includes(permission)) {
      callback(true);
      return;
    }
    const names = {
      media: "摄像头或麦克风",
      geolocation: "位置",
      notifications: "通知",
      "clipboard-read": "剪贴板",
    };
    const window = getWindow();
    if (!names[permission] || !window || window.isDestroyed()) {
      callback(false);
      return;
    }
    try {
      const origin = new URL(details.requestingUrl || contents.getURL()).origin;
      const key = `${origin}|${permission}`;
      if (key in settings.permissions) {
        callback(settings.permissions[key]);
        return;
      }
      const answer = await dialog.showMessageBox(window, {
        type: "question",
        title: "网站权限",
        message: `${origin} 请求使用${names[permission]}`,
        buttons: ["拒绝", "允许"],
        defaultId: 0,
        cancelId: 0,
      });
      settings.permissions[key] = answer.response === 1;
      saveSettings(settings);
      callback(answer.response === 1);
    } catch {
      callback(false);
    }
  });
  // HTTP 认证是站点发出的挑战；凭证只交给 Chromium，不落盘。
  app.on("login", (event, contents, _details, authInfo, callback) => {
    if (contents.session !== browsing) {
      return;
    }
    event.preventDefault();
    const window = getWindow();
    if (!window || window.isDestroyed()) {
      callback();
      return;
    }
    const id = randomUUID();
    const finish = (username, password) => {
      requests.delete(id);
      contents.removeListener("destroyed", cancel);
      callback(username, password);
    };
    const cancel = () => {
      if (requests.has(id)) {
        finish();
        send("browser:auth-closed", id);
      }
    };
    requests.set(id, finish);
    contents.once("destroyed", cancel);
    window.show();
    window.focus();
    send("browser:auth", {
      id,
      host: authInfo.host,
      realm: authInfo.realm,
      proxy: authInfo.isProxy,
    });
  });
  app.on("before-quit", () => {
    for (const finish of requests.values()) {
      finish();
    }
  });
  return (answer) => {
    const finish = requests.get(answer.id);
    if (!finish) {
      return;
    }
    if (answer.cancel) {
      finish();
    } else {
      finish(String(answer.username), String(answer.password));
    }
  };
}
