// 两个平台安装包收齐后生成同一份下载校验清单。
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(await fs.readFile(new URL("package.json", root), "utf8"));
const names = [
  `agentic-${pkg.version}-mac-arm64.dmg`,
  `agentic-${pkg.version}-mac-arm64.zip`,
  `agentic-${pkg.version}-win-x64.exe`,
];
const lines = [];
for (const name of names) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(new URL(`release/production/${name}`, root))) {
    hash.update(chunk);
  }
  lines.push(`${hash.digest("hex")}  ${name}`);
}
const content = lines.join("\n") + "\n";
await fs.writeFile(new URL("release/production/checksums.txt", root), content);
await fs.writeFile(new URL("site/public/checksums.txt", root), content);
console.log(content);
