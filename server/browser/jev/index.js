import { setTimeout as delay } from "node:timers/promises";
import { choose, fieldText } from "./ai.js";
import { observe, executeAction } from "./actions.js";

export default async function runJev(instructions, id, model, config, connection) {
  if (typeof instructions !== "string" || !instructions.trim()) {
    throw new Error("page.run(instructions) 需要具体的浏览器任务");
  }
  if (!config.browser.jev_key) {
    throw new Error("请在设置 → 浏览器控制中填写 Jev API Key");
  }
  if (!model) {
    throw new Error("Jev 的文字输入需要调用方传入当前文本模型");
  }
  const signal = connection.signal;
  const actions = [];
  const usage = [];
  const started = Date.now();
  let page = await observe(connection, id);
  let status;
  let pendingText;
  while (true) {
    signal.throwIfAborted();
    const decision = await choose(instructions, page, actions, config, signal);
    usage.push({ purpose: "decision", model: decision.model, usage: decision.usage });
    signal.throwIfAborted();
    const current = await observe(connection, id);
    if (current.marker !== page.marker) {
      page = current;
      pendingText = undefined;
      continue;
    }
    if (decision.choice === "DONE" || decision.choice === "BLOCKED") {
      status = decision.choice === "DONE" ? "completed" : "blocked";
      page = current;
      break;
    }
    const action = page.actions.find((item) => item.id === decision.choice);
    let text;
    if (action.kind === "fill") {
      const input = JSON.stringify([
        instructions,
        action,
        page.title,
        page.text,
        actions.slice(-6),
      ]);
      if (pendingText?.input === input) {
        text = pendingText.text;
      } else {
        const result = await fieldText(instructions, page, action, actions, model, config, signal);
        usage.push({ purpose: "text", model: result.model, usage: result.usage });
        text = result.text;
        pendingText = { input, text };
      }
    }
    if (action.kind === "wait") {
      await delay(200, undefined, { signal });
    } else {
      const result = await executeAction(connection, id, action, page.marker, text);
      if (result.stale) {
        page = await observe(connection, id);
        continue;
      }
    }
    // 先记录已执行动作再读取结果；输入或导航失败时交给主 Agent 检查，绝不重放。
    const record = { action: action.label, kind: action.kind, text, page_changed: null };
    actions.push(record);
    pendingText = undefined;
    await delay(action.kind === "fill" ? 200 : 50, undefined, { signal });
    const next = await observe(connection, id);
    record.page_changed = next.marker !== page.marker;
    page = next;
  }
  return {
    status,
    verification: "主 Agent 必须根据最终页面核对业务目标；completed 仅表示 Jev 判断完成。",
    pageId: id,
    url: page.url,
    title: page.title,
    text: page.text,
    actions,
    usage,
    elapsed_ms: Date.now() - started,
  };
}
