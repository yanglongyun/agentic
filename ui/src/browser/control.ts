import { addTab, activateTab, closeTab, useBrowser, saveTabs } from "./store";
import { navigatePage } from "./views";
import type { BrowserToolRequest } from "./desktop";

export async function browserCommand(request: BrowserToolRequest) {
  const { method, args } = request;
  if (method === "tabs") {
    const state = useBrowser.getState();
    return state.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      active: tab.id === state.activeId,
    }));
  }
  if (method === "open") {
    return { id: addTab(args.url!) };
  }
  const tab = useBrowser.getState().tabs.find((item) => item.id === args.id);
  if (!tab) {
    throw new Error("标签不存在，请重新调用 browser.tabs()");
  }
  switch (method) {
    case "wake":
      if (tab.url === "about:blank") {
        throw new Error("空白标签请先通过 browser.open(url) 打开网页");
      }
      useBrowser.setState((state) => ({
        tabs: state.tabs.map((item) => (item.id === tab.id ? { ...item, awake: true } : item)),
      }));
      break;
    case "focus":
      activateTab(tab.id);
      useBrowser.setState({ open: true });
      saveTabs();
      break;
    case "goto":
      await navigatePage(tab.id, args.url!);
      break;
    case "close":
      closeTab(tab.id);
      break;
    default:
      throw new Error(`未知标签操作：${method}`);
  }
  return { id: tab.id };
}
