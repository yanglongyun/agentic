import type { WebviewTag } from "electron";
import { updateTab } from "./store";
const views = new Map<string, WebviewTag>();
export function viewOf(id: string) {
  return views.get(id);
}
export function bindView(id: string, view: WebviewTag | null) {
  if (view) {
    views.set(id, view);
  } else {
    views.delete(id);
  }
}
export async function navigatePage(id: string, url: string) {
  if (url !== "about:blank" && new URL(url).origin === window.location.origin) {
    throw new Error("这是 agentic 自己的地址，请在聊天界面使用。");
  }
  const view = viewOf(id);
  updateTab(id, { url, awake: url !== "about:blank", error: "", icon: "" });
  if (url === "about:blank") {
    updateTab(id, {
      title: "新标签页",
      ready: false,
      loading: false,
      canBack: false,
      canForward: false,
      zoom: 100,
      findMatches: 0,
      findActive: 0,
    });
  }
  if (view && url !== "about:blank") {
    try {
      await view.loadURL(url);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("ERR_ABORTED")) {
        throw error;
      }
    }
  }
}
