import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { saveImage } from "../images.js";

const running = new Set();

export async function execute(code, config, signal) {
  signal?.throwIfAborted();
  if (!process.connected) {
    throw new Error("浏览器工具需要在 agentic 桌面 App 中使用");
  }
  const sessionId = config.session_id;
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("浏览器工具缺少对话 ID");
  }
  if (running.has(sessionId)) {
    throw new Error("当前对话的另一个浏览器脚本正在执行，请等它结束后重试");
  }
  const runId = randomUUID();
  const controller = new AbortController();
  const stopped = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  const worker = new Worker(new URL("./worker.js", import.meta.url), { workerData: { code } });
  running.add(sessionId);
  let imageURL;
  let closed = false;
  const timer = setTimeout(
    () => controller.abort(new Error("浏览器脚本执行超过 60 秒；请读取页面确认操作结果")),
    60000,
  );
  try {
    return await new Promise((resolve, reject) => {
      function abort() {
        reject(stopped.reason);
      }
      function disconnect() {
        reject(new Error("桌面连接已断开；请检查页面后再操作"));
      }
      async function receive(message) {
        if (message.type !== "browser:result" || message.runId !== runId || closed) {
          return;
        }
        try {
          let result = message.result;
          if (result?.png) {
            imageURL = await saveImage(
              config.images_dir,
              Buffer.from(result.png, "base64"),
              ".png",
              stopped,
            );
            config.run_images?.add(imageURL);
            result = { imageURL, width: result.width, height: result.height, url: result.url };
          }
          if (!closed) {
            worker.postMessage({ id: message.id, result, error: message.error });
          }
        } catch (error) {
          reject(error);
        }
      }
      process.on("message", receive);
      process.once("disconnect", disconnect);
      stopped.addEventListener("abort", abort, { once: true });
      worker.once("exit", (code) => {
        process.off("message", receive);
        process.off("disconnect", disconnect);
        stopped.removeEventListener("abort", abort);
        if (!closed) {
          reject(new Error(`浏览器脚本线程已退出（${code}）`));
        }
      });
      worker.once("error", reject);
      worker.on("message", (message) => {
        if (closed || stopped.aborted) {
          return;
        }
        if (message.type === "request") {
          process.send({ ...message, type: "browser:request", runId, sessionId }, (error) => {
            if (error) {
              reject(error);
            }
          });
        } else if (message.type === "done") {
          if (message.error) {
            reject(new Error(message.error));
          } else {
            let text = message.text;
            if (text.length > config.max_output) {
              text = text.slice(0, config.max_output) + "\n…（输出已截断）";
            }
            resolve({ text, imageURL });
          }
        }
      });
      if (stopped.aborted) {
        abort();
      }
    });
  } finally {
    closed = true;
    clearTimeout(timer);
    if (process.connected) {
      process.send({ type: "browser:cancel", runId }, () => {});
    }
    await worker.terminate();
    running.delete(sessionId);
  }
}
