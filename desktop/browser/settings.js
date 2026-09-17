import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

export function loadSettings() {
  const filename = path.join(app.getPath("userData"), "browser-settings.json");
  if (fs.existsSync(filename)) {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  }
  return {
    searchEngine: "https://www.bing.com/search?q={query}",
    downloadDirectory: "",
    permissions: {},
  };
}
export function saveSettings(settings) {
  fs.writeFileSync(
    path.join(app.getPath("userData"), "browser-settings.json"),
    JSON.stringify(settings, null, 2),
    { mode: 0o600 },
  );
}
