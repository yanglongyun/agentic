// Electron 的本地服务入口，直接使用现有后端，不改 Agent 和 API。
import { createServer } from "../server/index.js";
import { loadConfig, paths } from "../server/config.js";

const config = loadConfig();
const runtime = createServer({ p: paths(), config });
const port = Number(process.argv[2] || 0);
let closing = false;

async function shutdown() {
  if (closing) {
    return;
  }
  closing = true;
  await runtime.close();
  process.exit(0);
}
process.on("message", (message) => {
  if (message.type === "shutdown") {
    void shutdown();
  }
});
process.on("disconnect", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

try {
  let origin;
  try {
    origin = await runtime.listen(`127.0.0.1:${port}`);
  } catch (error) {
    if (error.code !== "EADDRINUSE" || port === 0) {
      throw error;
    }
    origin = await runtime.listen("127.0.0.1:0");
  }
  // 令牌仅经父子进程通道交付，不写日志，不暴露给网页。
  process.send({ type: "ready", origin, token: config.api.token });
} catch (error) {
  console.error(error.message);
  await runtime.close();
  process.exit(1);
}
