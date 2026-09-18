const { contextBridge, ipcRenderer } = require("electron");
function listen(channel, callback) {
  const listener = (_event, detail) => callback(detail);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
contextBridge.exposeInMainWorld("agenticDesktop", {
  computerState() {
    return ipcRenderer.invoke("computer:state");
  },
  computerEnabled(value) {
    return ipcRenderer.invoke("computer:enabled", value);
  },
  computerPermission(kind) {
    return ipcRenderer.invoke("computer:permission", kind);
  },
  onComputerChanged(callback) {
    return listen("computer:changed", callback);
  },
  onBrowserTool(callback) {
    return listen("browser:tool-request", callback);
  },
  browserToolResult(result) {
    return ipcRenderer.invoke("browser:tool-result", result);
  },
  onOpenTab(callback) {
    return listen("browser:open-tab", callback);
  },
  onDownload(callback) {
    return listen("browser:download", callback);
  },
  onCommand(callback) {
    return listen("browser:command", callback);
  },
  onAuth(callback) {
    return listen("browser:auth", callback);
  },
  onAuthClosed(callback) {
    return listen("browser:auth-closed", callback);
  },
  state() {
    return ipcRenderer.invoke("browser:state");
  },
  visible(value) {
    return ipcRenderer.invoke("browser:visible", value);
  },
  register(id, contentsId, sessionId) {
    return ipcRenderer.invoke("browser:register", id, contentsId, sessionId);
  },
  openExternal(url) {
    return ipcRenderer.invoke("browser:open-external", url);
  },
  downloadAction(action, id) {
    return ipcRenderer.invoke("browser:download-action", action, id);
  },
  pageAction(id, action) {
    return ipcRenderer.invoke("browser:page-action", id, action);
  },
  saveSettings(patch) {
    return ipcRenderer.invoke("browser:settings", patch);
  },
  chooseDirectory() {
    return ipcRenderer.invoke("browser:choose-directory");
  },
  revokePermission(key) {
    return ipcRenderer.invoke("browser:revoke-permission", key);
  },
  clearData(kind) {
    return ipcRenderer.invoke("browser:clear-data", kind);
  },
  answerAuth(answer) {
    return ipcRenderer.invoke("browser:auth-answer", answer);
  },
  chromeProfiles() {
    return ipcRenderer.invoke("browser:chrome-profiles");
  },
  importChrome(profile, kind) {
    return ipcRenderer.invoke("browser:import-chrome", profile, kind);
  },
});
