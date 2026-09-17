import { randomUUID } from "node:crypto";
import { body, json, fail } from "../../../http.js";
export default async function post(req, res, { db }) {
  const { bookmarks } = await body(req, ["bookmarks"], 8 * 1024 * 1024);
  if (!Array.isArray(bookmarks)) {
    fail(400, "书签必须是数组");
  }
  let count = 0;
  const now = Date.now();
  const insert = db.prepare(
    "INSERT INTO browser_bookmarks (id, parent_id, kind, title, url, icon, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '', ?, ?)",
  );
  function add(items, parent, depth) {
    if (depth > 30) {
      fail(400, "目录层级过深");
    }
    for (const item of items) {
      if (
        !item ||
        typeof item.title !== "string" ||
        !item.title.trim() ||
        item.title.length > 500 ||
        ++count > 20000
      ) {
        fail(400, "书签信息无效或过多");
      }
      const id = randomUUID();
      if (Array.isArray(item.children)) {
        insert.run(id, parent, "folder", item.title, "", now, now);
        add(item.children, id, depth + 1);
      } else {
        if (typeof item.url !== "string" || item.url.length > 8192) {
          fail(400, "书签网址无效");
        }
        try {
          if (!["http:", "https:"].includes(new URL(item.url).protocol)) {
            fail(400, "书签网址无效");
          }
        } catch {
          fail(400, "书签网址无效");
        }
        insert.run(id, parent, "link", item.title, item.url, now, now);
      }
    }
  }
  db.exec("BEGIN");
  try {
    add(bookmarks, "", 0);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return json(res, 201, { count });
}
