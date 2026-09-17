import { randomUUID } from "node:crypto";
import { body, json, fail } from "../../http.js";
export default async function post(req, res, { db }) {
  const data = await body(req, ["parent_id", "kind", "title", "url", "icon"]);
  const { kind, title, parent_id = "", url = "", icon = "" } = data;
  if (
    !["link", "folder"].includes(kind) ||
    typeof title !== "string" ||
    !title.trim() ||
    title.length > 500 ||
    typeof parent_id !== "string" ||
    typeof url !== "string" ||
    url.length > 8192 ||
    typeof icon !== "string" ||
    icon.length > 8192
  ) {
    fail(400, "书签信息无效");
  }
  if (kind === "link") {
    try {
      if (!["http:", "https:"].includes(new URL(url).protocol)) {
        fail(400, "书签网址无效");
      }
    } catch {
      fail(400, "书签网址无效");
    }
  }
  if (
    parent_id &&
    !db.prepare("SELECT id FROM browser_bookmarks WHERE id = ? AND kind = 'folder'").get(parent_id)
  ) {
    fail(400, "书签目录不存在");
  }
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    "INSERT INTO browser_bookmarks (id, parent_id, kind, title, url, icon, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, parent_id, kind, title.trim(), kind === "link" ? url : "", icon, now, now);
  return json(res, 201, {
    bookmark: db.prepare("SELECT * FROM browser_bookmarks WHERE id = ?").get(id),
  });
}
