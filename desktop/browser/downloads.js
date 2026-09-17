import { app, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function setupDownloads(browsing, send, settings) {
  const items = new Map();
  const filename = path.join(app.getPath("userData"), "browser-downloads.json");
  let records = [];
  if (fs.existsSync(filename)) {
    records = JSON.parse(fs.readFileSync(filename, "utf8"));
    for (const record of records) {
      if (record.state === "progressing") {
        record.state = "interrupted";
      }
    }
  }
  function save() {
    fs.writeFileSync(filename, JSON.stringify(records), { mode: 0o600 });
  }
  browsing.on("will-download", (_event, item) => {
    const directory = settings.downloadDirectory || app.getPath("downloads");
    const name = path.basename(item.getFilename());
    const extension = path.extname(name);
    const base = path.basename(name, extension);
    let target = path.join(directory, name);
    let number = 1;
    while (fs.existsSync(target) || records.some((record) => record.path === target)) {
      target = path.join(directory, `${base} (${number++})${extension}`);
    }
    item.setSavePath(target);
    const record = {
      id: randomUUID(),
      name: path.basename(target),
      path: target,
      state: "progressing",
      received: 0,
      total: item.getTotalBytes(),
      createdAt: Date.now(),
    };
    records.unshift(record);
    items.set(record.id, item);
    function report(state) {
      Object.assign(record, {
        state,
        received: item.getReceivedBytes(),
        total: item.getTotalBytes(),
      });
      send("browser:download", record);
    }
    report("progressing");
    save();
    item.on("updated", (_event, state) => report(state));
    item.once("done", (_event, state) => {
      report(state);
      items.delete(record.id);
      save();
    });
  });
  return {
    list() {
      return records;
    },
    cancel(id) {
      items.get(id)?.cancel();
    },
    reveal(id) {
      const record = records.find((item) => item.id === id);
      if (!record || record.state !== "completed" || !fs.existsSync(record.path)) {
        throw new Error("下载文件不存在");
      }
      shell.showItemInFolder(record.path);
    },
    clear() {
      records = records.filter((item) => item.state === "progressing");
      save();
      return records;
    },
  };
}
