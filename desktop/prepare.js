// 桌面安装包携带运行现有后端所需的 Node.js，不依赖用户机器的 PATH。
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = path.join(root, "desktop/runtime");
await fs.mkdir(runtime, { recursive: true });
await fs.copyFile(path.join(root, "package.json"), path.join(runtime, "package.json"));
const target = path.join(runtime, process.platform === "win32" ? "node.exe" : "node");
await fs.copyFile(process.execPath, target);
await fs.chmod(target, 0o755);
const response = await fetch(
  `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`,
);
if (!response.ok) {
  throw new Error("读取 Node.js 许可证失败");
}
await fs.writeFile(path.join(runtime, "LICENSE"), await response.text());
console.log(
  `桌面包运行环境：Node.js ${process.versions.node}，${process.platform}/${process.arch}`,
);
