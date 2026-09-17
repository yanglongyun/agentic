import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const directory = path.join(os.homedir(), "Library/Application Support/Google/Chrome");

export function profiles() {
  if (process.platform !== "darwin" || !fs.existsSync(directory)) {
    return [];
  }
  return fs
    .readdirSync(directory)
    .filter((name) => /^(Default|Profile \d+)$/.test(name))
    .map((id) => ({ id, name: id }));
}
export function readBookmarks(profile) {
  if (!profiles().some((item) => item.id === profile)) {
    throw new Error("Chrome 配置不存在");
  }
  const file = path.join(directory, profile, "Bookmarks");
  if (!fs.existsSync(file)) {
    return [];
  }
  const { roots } = JSON.parse(fs.readFileSync(file, "utf8"));
  function walk(node) {
    if (node.type === "url") {
      if (!/^https?:\/\//i.test(node.url)) {
        return null;
      }
      return { title: node.name || node.url, url: node.url };
    }
    const children = node.children.map(walk).filter(Boolean);
    return { title: node.name || "Chrome 书签", children };
  }
  const bookmarks = [];
  for (const name of ["bookmark_bar", "other", "synced"]) {
    if (roots[name]) {
      bookmarks.push(walk(roots[name]));
    }
  }
  return bookmarks;
}
export async function importCookies(browsing, node, core, profile) {
  if (!profiles().some((item) => item.id === profile)) {
    throw new Error("Chrome 配置不存在");
  }
  let output;
  try {
    output = await run(node, [path.join(core, "desktop/browser/import-worker.js"), profile], {
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    throw new Error("读取失败，请检查 Chrome 配置及钥匙串授权；拒绝授权后不会重试。");
  }
  const { cookies, failed: unreadable } = JSON.parse(output.stdout);
  let imported = 0;
  let failed = unreadable;
  for (const cookie of cookies) {
    try {
      await browsing.cookies.set(cookie);
      imported++;
    } catch {
      failed++;
    }
  }
  await browsing.cookies.flushStore();
  return { imported, failed };
}
