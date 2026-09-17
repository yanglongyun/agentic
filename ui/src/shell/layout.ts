// 壳布局:侧栏收起(宽屏)与抽屉(窄屏)。收起是长期偏好,跨启动记住。
import { create } from "zustand";

const KEY = "agentic.sidebar.collapsed";
const saved = (key: string) => {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
};
const savedCollapsed = () => saved(KEY) === "1";

function savedWidth(key: string) {
  const width = Number(saved(key));
  return Number.isFinite(width) && width > 0 ? width : null;
}

interface ShellState {
  /** 宽屏下侧栏是否收起。 */
  collapsed: boolean;
  /** 窄屏抽屉是否拉开(宽屏下无效,由样式裁决)。 */
  drawer: boolean;
  sidebarWidth: number;
  browserWidth: number | null;
  setSidebarWidth: (width: number) => void;
  setBrowserWidth: (width: number) => void;
  toggleCollapsed: () => void;
  openSidebar: () => void;
  closeDrawer: () => void;
}

export const useShell = create<ShellState>((set) => ({
  collapsed: savedCollapsed(),
  drawer: false,
  sidebarWidth: Math.min(440, Math.max(200, savedWidth("agentic.sidebar.width") ?? 240)),
  browserWidth: savedWidth("agentic.browser.width"),
  setSidebarWidth: (width) => {
    const next = Math.min(440, Math.max(200, Math.round(width)));
    set({ sidebarWidth: next });
    try {
      localStorage.setItem("agentic.sidebar.width", String(next));
    } catch {
      // 无法保存时，本次窗口仍可调整宽度。
    }
  },
  setBrowserWidth: (width) => {
    const next = Math.max(320, Math.round(width));
    set({ browserWidth: next });
    try {
      localStorage.setItem("agentic.browser.width", String(next));
    } catch {
      // 无法保存时，本次窗口仍可调整宽度。
    }
  },
  toggleCollapsed: () =>
    set((state) => {
      const collapsed = !state.collapsed;
      try {
        localStorage.setItem(KEY, collapsed ? "1" : "0");
      } catch {
        /* ignore */
      }
      return {
        collapsed,
        drawer: false,
      };
    }),
  // 顶栏菜单键:宽屏 = 展开,窄屏 = 拉抽屉。两个状态一起给,样式各取所需
  openSidebar: () =>
    set(() => {
      try {
        localStorage.setItem(KEY, "0");
      } catch {
        /* ignore */
      }
      return {
        collapsed: false,
        drawer: true,
      };
    }),
  closeDrawer: () => set({ drawer: false }),
}));
