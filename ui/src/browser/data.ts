import { create } from "zustand";
import { api } from "../lib/api";
import { toast } from "../overlay/toast";
export interface Bookmark {
  id: string;
  parent_id: string;
  kind: "folder" | "link";
  title: string;
  url: string;
  icon: string;
}
export interface Visit {
  url: string;
  title: string;
  icon: string;
  visits: number;
  visited_at: number;
}
export const useBookmarks = create<{ items: Bookmark[] }>(() => ({ items: [] }));
export async function loadBookmarks() {
  const { bookmarks } = await api.get<{ bookmarks: Bookmark[] }>("/api/browser/bookmarks");
  useBookmarks.setState({ items: bookmarks });
}
export function noteVisit(url: string, title: string, icon: string, visit: boolean) {
  if (!/^https?:/.test(url)) {
    return;
  }
  void api.post("/api/browser/history", { url, title, icon, visit }).catch(() => {});
}
export function reportError(error: unknown) {
  toast(error instanceof Error ? error.message : "操作失败");
}
