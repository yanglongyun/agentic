import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export async function buildComputer() {
  if (process.platform !== "darwin") {
    return;
  }
  const source = fileURLToPath(new URL("./main.swift", import.meta.url));
  const output = fileURLToPath(new URL("../runtime/agentic-computer", import.meta.url));
  await fs.mkdir(new URL("../runtime/", import.meta.url), { recursive: true });
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  const child = spawn(
    "xcrun",
    [
      "swiftc",
      "-parse-as-library",
      "-swift-version",
      "5",
      "-target",
      `${arch}-apple-macos13.0`,
      "-O",
      source,
      "-o",
      output,
    ],
    { stdio: "inherit" },
  );
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Mac 控制程序编译失败：${code}`));
        return;
      }
      resolve();
    });
  });
  console.log("Mac 控制程序已构建");
}
