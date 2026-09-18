import {
  loadBrowserPages,
  flushBrowserPages,
  addTab,
  activateTab,
  closeTab,
  groupFor,
  updateTab,
  setBrowserOpen,
} from "./store";
import { navigatePage, viewOf } from "./views";
import type { BrowserToolRequest } from "./desktop";

export async function browserCommand(request: BrowserToolRequest) {
  const { method, args, sessionId } = request;
  if (!sessionId) {
    throw new Error("浏览器工具缺少对话 ID");
  }
  await loadBrowserPages();
  const group = groupFor(sessionId);
  if (method === "tabs") {
    return group.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      active: tab.id === group.activeId,
    }));
  }
  if (method === "open") {
    const id = addTab(args.url!, false, undefined, sessionId);
    await flushBrowserPages();
    return { id };
  }
  const tab = group.tabs.find((item) => item.id === args.id);
  if (!tab) {
    throw new Error("标签不属于当前对话或已关闭，请重新调用 browser.tabs()");
  }
  switch (method) {
    case "check":
      break;
    case "wake":
      if (tab.url === "about:blank") {
        throw new Error("空白标签请先通过 browser.open(url) 打开网页");
      }
      updateTab(tab.id, { awake: true });
      break;
    case "focus":
      activateTab(tab.id);
      setBrowserOpen(true, sessionId);
      break;
    case "goto":
      await navigatePage(tab.id, args.url!);
      break;
    case "close":
      closeTab(tab.id);
      await flushBrowserPages();
      return { id: tab.id };
    default:
      throw new Error(`未知标签操作：${method}`);
  }
  await flushBrowserPages();
  // 草稿转为正式对话后，同步已有网页的归属，不重建网页。
  const view = viewOf(tab.id);
  if (view && tab.ready) {
    await window.agenticDesktop?.register(tab.id, view.getWebContentsId(), sessionId);
  }
  return { id: tab.id };
}
