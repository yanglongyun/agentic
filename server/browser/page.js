// 两种决策方式共用同一次浏览器运行，保持对话归属、取消和用户接管状态。
import { randomUUID } from "node:crypto";
import { saveImage } from "../images.js";

const running = new Set();

export function connect(config, signal) {
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
  const pending = new Map();
  const controller = new AbortController();
  const stopped = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  let imageURL;
  let closed = false;
  running.add(sessionId);

  function abort() {
    for (const entry of pending.values()) {
      entry.reject(stopped.reason);
    }
    pending.clear();
    if (process.connected) {
      process.send({ type: "browser:cancel", runId }, () => {});
    }
  }
  function disconnect() {
    controller.abort(new Error("桌面连接已断开；请检查页面后再操作"));
  }
  async function receive(message) {
    if (message.type !== "browser:result" || message.runId !== runId || closed) {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }
    try {
      if (message.error) {
        throw new Error(message.error);
      }
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
      stopped.throwIfAborted();
      entry.resolve(result);
    } catch (error) {
      entry.reject(error);
    } finally {
      pending.delete(message.id);
    }
  }
  process.on("message", receive);
  process.once("disconnect", disconnect);
  stopped.addEventListener("abort", abort, { once: true });

  function request(method, args = {}) {
    stopped.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      process.send({ type: "browser:request", runId, sessionId, id, method, args }, (error) => {
        if (error) {
          pending.delete(id);
          reject(error);
        }
      });
    });
  }
  function close() {
    closed = true;
    controller.abort(new Error("浏览器脚本已结束"));
    process.off("message", receive);
    process.off("disconnect", disconnect);
    stopped.removeEventListener("abort", abort);
    running.delete(sessionId);
  }
  return { request, close, signal: stopped, image: () => imageURL };
}
