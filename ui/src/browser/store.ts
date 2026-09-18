import { create } from "zustand";
import { api } from "../lib/api";
import { reportError } from "./data";

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
interface BrowserGroup {
  open: boolean;
  tabs: BrowserTab[];
  activeId: string;
  closed: { tab: SavedTab; index: number }[];
}
interface BrowserState {
  ready: boolean;
  sessionId: string;
  groups: Record<string, BrowserGroup>;
}
const emptyGroup: BrowserGroup = { open: false, tabs: [], activeId: "", closed: [] };
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
interface PageRecord extends SavedTab {
  session_id: string;
  position: number;
  active: number;
}
export const useBrowser = create<BrowserState>(() => ({ ready: false, sessionId: "", groups: {} }));
let loading: Promise<void> | undefined;
let saving: Promise<void> = Promise.resolve();

// 按发起顺序保存，避免导航、排序、关闭的请求乱序覆盖数据库。
function enqueueSave(write: () => Promise<unknown>): Promise<void> {
  saving = saving
    .catch(() => {})
    .then(write)
    .then(() => {});
  void saving.catch(reportError);
  return saving;
}
export function flushBrowserPages() {
  return saving;
}
export function loadBrowserPages(): Promise<void> {
  if (useBrowser.getState().ready) {
    return Promise.resolve();
  }
  if (loading) {
    return loading;
  }
  loading = api
    .get<{ pages: PageRecord[] }>("/api/browser/pages")
    .then(({ pages }) => {
      const groups: Record<string, BrowserGroup> = {};
      for (const page of pages) {
        let group = groups[page.session_id];
        if (!group) {
          group = { open: true, tabs: [], activeId: "", closed: [] };
          groups[page.session_id] = group;
        }
        group.tabs.push(
          runtime({ id: page.id, url: page.url, title: page.title, icon: page.icon }),
        );
        if (page.active) {
          group.activeId = page.id;
        }
      }
      const current = groups[useBrowser.getState().sessionId];
      const active = current?.tabs.find((tab) => tab.id === current.activeId);
      if (active) {
        active.awake = active.url !== "about:blank";
      }
      useBrowser.setState({ groups, ready: true });
    })
    .finally(() => {
      loading = undefined;
    });
  return loading;
}
export function groupFor(sessionId = useBrowser.getState().sessionId): BrowserGroup {
  return useBrowser.getState().groups[sessionId] || emptyGroup;
}
export function useBrowserGroup() {
  return useBrowser((state) => state.groups[state.sessionId] || emptyGroup);
}
function saveGroup(sessionId: string, group: BrowserGroup) {
  useBrowser.setState((state) => ({ groups: { ...state.groups, [sessionId]: group } }));
  savePages(sessionId);
}
function savePages(sessionId: string) {
  const group = groupFor(sessionId);
  const pages = group.tabs.map(({ id, url, title, icon }) => ({
    id,
    url,
    title,
    icon,
    active: id === group.activeId,
  }));
  return enqueueSave(() => api.put("/api/browser/pages", { session_id: sessionId, pages }));
}
export function selectBrowserSession(sessionId: string) {
  useBrowser.setState({ sessionId });
  const group = groupFor(sessionId);
  if (group.activeId) {
    activateTab(group.activeId);
  }
}
export function promoteBrowserDraft(sessionId: string): Promise<void> {
  const state = useBrowser.getState();
  if (!state.groups[""]) {
    return Promise.resolve();
  }
  // 先排入草稿的最终记录，再变更归属；网页仍使用原来的稳定 ID。
  savePages("");
  const groups = { ...state.groups, [sessionId]: state.groups[""] };
  delete groups[""];
  useBrowser.setState({ groups });
  return enqueueSave(() => api.post("/api/browser/pages/claim", { session_id: sessionId }));
}
export function removeBrowserSession(sessionId: string) {
  const groups = { ...useBrowser.getState().groups };
  delete groups[sessionId];
  useBrowser.setState({ groups });
}
export function findTab(id: string) {
  for (const [sessionId, group] of Object.entries(useBrowser.getState().groups)) {
    const tab = group.tabs.find((item) => item.id === id);
    if (tab) {
      return { sessionId, group, tab };
    }
  }
}
export function setBrowserOpen(open: boolean, sessionId = useBrowser.getState().sessionId) {
  useBrowser.setState((state) => ({
    groups: { ...state.groups, [sessionId]: { ...groupFor(sessionId), open } },
  }));
}
export function addTab(
  url = "about:blank",
  background = false,
  openerId?: string,
  sessionId = useBrowser.getState().sessionId,
) {
  // 弹出的网页跟随来源标签，即使用户已经切换到别的对话。
  if (openerId) {
    const opener = findTab(openerId);
    if (!opener) {
      throw new Error("来源标签已关闭");
    }
    sessionId = opener.sessionId;
  }
  const tab = runtime({
    id: crypto.randomUUID(),
    url,
    title: url === "about:blank" ? "新标签页" : url,
    icon: "",
  });
  tab.awake = url !== "about:blank";
  const group = groupFor(sessionId);
  const tabs = group.tabs.slice();
  const source = tabs.findIndex((item) => item.id === openerId);
  tabs.splice(source < 0 ? tabs.length : source + 1, 0, tab);
  saveGroup(sessionId, {
    ...group,
    open: true,
    tabs,
    activeId: background && group.activeId ? group.activeId : tab.id,
  });
  return tab.id;
}
export function activateTab(id: string) {
  const found = findTab(id);
  if (!found) {
    return;
  }
  saveGroup(found.sessionId, {
    ...found.group,
    activeId: id,
    tabs: found.group.tabs.map((tab) =>
      tab.id === id ? { ...tab, awake: tab.url !== "about:blank" } : tab,
    ),
  });
}
export function toggleBrowser() {
  const group = groupFor();
  if (!group.open && !group.tabs.length) {
    addTab();
  } else {
    setBrowserOpen(!group.open);
  }
}
export function closeTab(id: string) {
  const found = findTab(id);
  if (!found) {
    return;
  }
  const { group, tab, sessionId } = found;
  const index = group.tabs.findIndex((item) => item.id === id);
  let tabs = group.tabs.filter((item) => item.id !== id);
  const activeId =
    group.activeId === id ? tabs[Math.min(index, tabs.length - 1)]?.id || "" : group.activeId;
  tabs = tabs.map((item) =>
    item.id === activeId ? { ...item, awake: item.url !== "about:blank" } : item,
  );
  saveGroup(sessionId, {
    ...group,
    tabs,
    activeId,
    closed: [
      ...group.closed,
      { tab: { id: tab.id, url: tab.url, title: tab.title, icon: tab.icon }, index },
    ],
  });
}
export function reopenTab() {
  const state = useBrowser.getState();
  const group = groupFor();
  const saved = group.closed.at(-1);
  if (!saved) {
    return;
  }
  const tabs = group.tabs.slice();
  const tab = runtime(saved.tab);
  tab.awake = tab.url !== "about:blank";
  tabs.splice(saved.index, 0, tab);
  saveGroup(state.sessionId, {
    ...group,
    tabs,
    activeId: tab.id,
    open: true,
    closed: group.closed.slice(0, -1),
  });
}
export function reorderTabs(from: number, to: number) {
  const group = groupFor();
  const tabs = group.tabs.slice();
  const [tab] = tabs.splice(from, 1);
  if (!tab) {
    return;
  }
  tabs.splice(to, 0, tab);
  saveGroup(useBrowser.getState().sessionId, { ...group, tabs });
}
export function updateTab(id: string, patch: Partial<BrowserTab>) {
  const found = findTab(id);
  if (!found) {
    return;
  }
  const group = {
    ...found.group,
    tabs: found.group.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
  };
  useBrowser.setState((state) => ({ groups: { ...state.groups, [found.sessionId]: group } }));
  if ("url" in patch || "title" in patch || "icon" in patch) {
    savePages(found.sessionId);
  }
}
