// 正式构建必须完成签名、公证和验证；开发打包继续使用 app:dist。
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));

async function run(command, args) {
  const child = spawn(command, args, { cwd: root, stdio: "inherit" });
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} 执行失败：${code}`));
        return;
      }
      resolve();
    });
  });
}

if (process.platform !== "darwin" && process.platform !== "win32") {
  throw new Error("正式安装包在 macOS 或 Windows 上构建");
}
if (process.platform === "darwin") {
  if (!process.env.APPLE_KEYCHAIN_PROFILE) {
    throw new Error("请设置 APPLE_KEYCHAIN_PROFILE，正式发布必须完成公证");
  }
  if (process.arch !== "arm64") {
    throw new Error("macOS 安装包需要在 Apple Silicon 机器构建");
  }
  await run("xcrun", [
    "notarytool",
    "history",
    "--keychain-profile",
    process.env.APPLE_KEYCHAIN_PROFILE,
  ]);
}
if (process.platform === "win32" && process.arch !== "x64") {
  throw new Error("Windows 安装包需要使用 x64 Node.js 构建");
}
await run(process.execPath, [
  "ui/node_modules/typescript/bin/tsc",
  "--noEmit",
  "--project",
  "ui/tsconfig.json",
]);
await run(process.execPath, [
  "ui/node_modules/vite/bin/vite.js",
  "build",
  "ui",
  "--config",
  "ui/vite.config.ts",
]);
await run(process.execPath, ["desktop/prepare.js"]);
const platform = process.platform === "darwin" ? "--mac" : "--win";
const arch = process.platform === "darwin" ? "--arm64" : "--x64";
await run(process.execPath, [
  "node_modules/electron-builder/cli.js",
  "--config",
  "electron-builder.release.json",
  platform,
  arch,
  "--publish",
  "never",
]);

if (process.platform === "darwin") {
  const app = "release/production/mac-arm64/agentic.app";
  const dmg = `release/production/agentic-${pkg.version}-mac-arm64.dmg`;
  await run("codesign", ["--verify", "--deep", "--strict", app]);
  await run("xcrun", ["stapler", "validate", app]);
  await run("spctl", ["--assess", "--type", "execute", "--verbose", app]);
  await run("codesign", [
    "--sign",
    "Developer ID Application: Chuan Zhi (Chengdu) Information Technology Co., Ltd. (92696T726U)",
    "--timestamp",
    dmg,
  ]);
  await run("xcrun", [
    "notarytool",
    "submit",
    dmg,
    "--keychain-profile",
    process.env.APPLE_KEYCHAIN_PROFILE,
    "--wait",
  ]);
  await run("xcrun", ["stapler", "staple", dmg]);
  await run("xcrun", ["stapler", "validate", dmg]);
  // DMG 公证后内容有变化；本产品不发布自动更新清单或构建时的旧 blockmap。
  await fs.rm(new URL(`../${dmg}.blockmap`, import.meta.url), { force: true });
}
