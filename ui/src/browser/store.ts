import { create } from "zustand";

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  icon: string;
  awake: boolean;
  ready: boolean;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  error: string;
  zoom: number;
  findMatches: number;
  findActive: number;
}
interface SavedTab {
  id: string;
  url: string;
  title: string;
  icon: string;
}
interface BrowserState {
  open: boolean;
  tabs: BrowserTab[];
  activeId: string;
  closed: { tab: SavedTab; index: number }[];
}
function runtime(tab: SavedTab): BrowserTab {
  return {
    ...tab,
    awake: false,
    ready: false,
    loading: false,
    canBack: false,
    canForward: false,
    error: "",
    zoom: 100,
    findMatches: 0,
    findActive: 0,
  };
}
export function addressURL(
  value: string,
  search = "https://www.bing.com/search?q={query}",
): string {
  const text = value.trim();
  if (!text) {
    return "about:blank";
  }
  if (/^https?:\/\//i.test(text)) {
    return new URL(text).href;
  }
  if (
    !/\s/.test(text) &&
    /^(?:localhost|(?:[a-z0-9-]+\.)+[a-z0-9-]+)(?::\d+)?(?:[/?#]|$)/i.test(text)
  ) {
    const protocol = /^localhost(?::|\/|$)|^127\.0\.0\.1(?::|\/|$)/i.test(text) ? "http" : "https";
    return new URL(`${protocol}://${text}`).href;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    throw new Error("只支持 HTTP 或 HTTPS 网址");
  }
  return search.replace("{query}", encodeURIComponent(text));
}
const initial: BrowserState = { open: false, tabs: [], activeId: "", closed: [] };
try {
  const raw = localStorage.getItem("agentic.browser.tabs");
  if (raw) {
    const saved = JSON.parse(raw);
    initial.open = saved.open === true;
    initial.tabs = saved.tabs.map((tab: SavedTab) => runtime(tab));
    initial.activeId = saved.activeId;
    const active = initial.tabs.find((tab) => tab.id === initial.activeId);
    if (active) {
      active.awake = active.url !== "about:blank";
    }
  }
} catch {
  /* 本地记录损坏时从空白面板开始，不影响聊天数据。 */
}
export const useBrowser = create<BrowserState>(() => initial);
export function saveTabs() {
  const { open, tabs, activeId } = useBrowser.getState();
  try {
    localStorage.setItem(
      "agentic.browser.tabs",
      JSON.stringify({
        open,
        activeId,
        tabs: tabs.map(({ id, url, title, icon }) => ({ id, url, title, icon })),
      }),
    );
  } catch {
    /* 存储不可用时仍可以浏览。 */
  }
}
export function addTab(url = "about:blank", background = false, openerId?: string) {
  const tab = runtime({
    id: crypto.randomUUID(),
    url,
    title: url === "about:blank" ? "新标签页" : url,
    icon: "",
  });
  tab.awake = url !== "about:blank";
  useBrowser.setState((state) => {
    const tabs = state.tabs.slice();
    const source = tabs.findIndex((item) => item.id === openerId);
    tabs.splice(source < 0 ? tabs.length : source + 1, 0, tab);
    return { open: true, tabs, activeId: background && state.activeId ? state.activeId : tab.id };
  });
  saveTabs();
  return tab.id;
}
export function activateTab(id: string) {
  useBrowser.setState((state) => ({
    activeId: id,
    tabs: state.tabs.map((tab) =>
      tab.id === id ? { ...tab, awake: tab.url !== "about:blank" } : tab,
    ),
  }));
  saveTabs();
}
export function toggleBrowser() {
  const state = useBrowser.getState();
  if (!state.open && !state.tabs.length) {
    addTab();
  } else {
    useBrowser.setState({ open: !state.open });
    saveTabs();
  }
}
export function closeTab(id: string) {
  useBrowser.setState((state) => {
    const index = state.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) {
      return state;
    }
    const tab = state.tabs[index];
    let tabs = state.tabs.filter((item) => item.id !== id);
    const activeId =
      state.activeId === id ? tabs[Math.min(index, tabs.length - 1)]?.id || "" : state.activeId;
    tabs = tabs.map((item) =>
      item.id === activeId ? { ...item, awake: item.url !== "about:blank" } : item,
    );
    return {
      tabs,
      activeId,
      closed: [
        ...state.closed,
        { tab: { id: tab.id, url: tab.url, title: tab.title, icon: tab.icon }, index },
      ],
    };
  });
  saveTabs();
}
export function reopenTab() {
  const state = useBrowser.getState();
  const saved = state.closed.at(-1);
  if (!saved) {
    return;
  }
  const tabs = state.tabs.slice();
  const tab = runtime(saved.tab);
  tab.awake = tab.url !== "about:blank";
  tabs.splice(saved.index, 0, tab);
  useBrowser.setState({ tabs, activeId: tab.id, open: true, closed: state.closed.slice(0, -1) });
  saveTabs();
}
export function reorderTabs(from: number, to: number) {
  const tabs = useBrowser.getState().tabs.slice();
  const [tab] = tabs.splice(from, 1);
  tabs.splice(to, 0, tab);
  useBrowser.setState({ tabs });
  saveTabs();
}
export function updateTab(id: string, patch: Partial<BrowserTab>) {
  useBrowser.setState((state) => ({
    tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
  }));
  if ("url" in patch || "title" in patch || "icon" in patch) {
    saveTabs();
  }
}
