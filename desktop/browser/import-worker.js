// 用客户端自带的 Node.js 读取 SQLite，结果只经父子进程管道交付给 Electron。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { pbkdf2Sync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { decryptCookie } from "./chrome-cookie.js";

try {
  const profile = process.argv[2];
  if (process.platform !== "darwin" || !/^(Default|Profile \d+)$/.test(profile)) {
    throw new Error("Chrome 配置无效");
  }
  const source = path.join(
    os.homedir(),
    "Library/Application Support/Google/Chrome",
    profile,
    "Cookies",
  );
  // 只有用户主动点“导入登录状态”才会执行；授权拒绝后直接结束。
  const password = execFileSync(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-chrome-"));
  let db;
  try {
    const file = path.join(directory, "Cookies");
    fs.copyFileSync(source, file);
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(source + suffix)) {
        fs.copyFileSync(source + suffix, file + suffix);
      }
    }
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db
      .prepare(
        "SELECT host_key, name, value, encrypted_value, path, expires_utc / 1000000.0 AS expires_seconds, is_secure, is_httponly, samesite, is_persistent FROM cookies",
      )
      .all();
    const cookies = [];
    let failed = 0;
    const sameSites = { "-1": "unspecified", 0: "no_restriction", 1: "lax", 2: "strict" };
    for (const row of rows) {
      try {
        const expires = row.expires_seconds - 11644473600;
        if (row.is_persistent && expires < Date.now() / 1000) {
          continue;
        }
        const value = row.encrypted_value.length
          ? decryptCookie(row.encrypted_value, key, row.host_key)
          : row.value;
        const cookie = {
          url: `${row.is_secure ? "https" : "http"}://${row.host_key.replace(/^\./, "")}${row.path}`,
          name: row.name,
          value,
          path: row.path,
          secure: Boolean(row.is_secure),
          httpOnly: Boolean(row.is_httponly),
          sameSite: sameSites[row.samesite],
        };
        if (row.host_key.startsWith(".")) {
          cookie.domain = row.host_key;
        }
        if (row.is_persistent) {
          cookie.expirationDate = expires;
        }
        cookies.push(cookie);
      } catch {
        failed++;
      }
    }
    process.stdout.write(JSON.stringify({ cookies, failed }));
  } finally {
    db?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
} catch {
  // 不把钥匙串命令、Cookie 或数据库内容写进日志。
  process.stderr.write("无法读取 Chrome 登录状态：请检查 Chrome 配置及钥匙串授权。");
  process.exitCode = 1;
}
