import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { buildComputer } from "./computer/build.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const env = { ...process.env, AGENT_NODE: process.execPath };
await buildComputer();
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [root], { cwd: root, env, stdio: "inherit" });
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
