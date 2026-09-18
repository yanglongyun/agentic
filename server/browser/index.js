import { Worker } from "node:worker_threads";
import { connect } from "./page.js";
import runJev from "./jev/index.js";

export async function execute(code, config, signal, model) {
  const controller = new AbortController();
  const stopped = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  const connection = connect(config, stopped);
  const worker = new Worker(new URL("./worker.js", import.meta.url), { workerData: { code } });
  let closed = false;
  let busy = false;
  let timeout = 60000;
  if (config.browser.mode === "jev") {
    timeout = config.run_timeout * 1000;
  }
  const timer = setTimeout(
    () => controller.abort(new Error("浏览器执行超时；请读取页面确认操作结果")),
    timeout,
  );
  try {
    return await new Promise((resolve, reject) => {
      function abort() {
        reject(connection.signal.reason);
      }
      connection.signal.addEventListener("abort", abort, { once: true });
      worker.once("exit", (code) => {
        connection.signal.removeEventListener("abort", abort);
        if (!closed) {
          reject(new Error(`浏览器脚本线程已退出（${code}）`));
        }
      });
      worker.once("error", reject);
      worker.on("message", async (message) => {
        if (closed || connection.signal.aborted) {
          return;
        }
        if (message.type === "request") {
          try {
            if (busy) {
              throw new Error("Jev 任务执行期间请等待 page.run() 返回，再进行其他操作");
            }
            let result;
            if (message.method === "run") {
              if (config.browser.mode !== "jev") {
                throw new Error("page.run() 需要在设置中选择 Jev 模式");
              }
              busy = true;
              try {
                result = await runJev(
                  message.args.instructions,
                  message.args.id,
                  model,
                  config,
                  connection,
                );
              } finally {
                busy = false;
              }
            } else {
              result = await connection.request(message.method, message.args);
            }
            if (!closed) {
              worker.postMessage({ id: message.id, result });
            }
          } catch (error) {
            if (!closed) {
              worker.postMessage({ id: message.id, error: error.message });
            }
          }
        } else if (message.type === "done") {
          if (message.error) {
            reject(new Error(message.error));
          } else {
            let text = message.text;
            if (text.length > config.max_output) {
              text = text.slice(0, config.max_output) + "\n…（输出已截断）";
            }
            resolve({ text, imageURL: connection.image() });
          }
        }
      });
      if (connection.signal.aborted) {
        abort();
      }
    });
  } finally {
    closed = true;
    clearTimeout(timer);
    connection.close();
    await worker.terminate();
  }
}
