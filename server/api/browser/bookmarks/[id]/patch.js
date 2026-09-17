import { body, json, fail } from "../../../http.js";
export default async function patch(req, res, { db, bookmarkId }) {
  const data = await body(req, ["title", "url", "parent_id"]);
  const bookmark = db.prepare("SELECT * FROM browser_bookmarks WHERE id = ?").get(bookmarkId);
  if (!bookmark) {
    fail(404, "书签不存在");
  }
  const title = data.title;
  const url = data.url === undefined ? bookmark.url : data.url;
  const parent = data.parent_id === undefined ? bookmark.parent_id : data.parent_id;
  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.length > 500 ||
    typeof url !== "string" ||
    url.length > 8192 ||
    typeof parent !== "string"
  ) {
    fail(400, "书签信息无效");
  }
  if (bookmark.kind === "link") {
    try {
      if (!["http:", "https:"].includes(new URL(url).protocol)) {
        fail(400, "书签网址无效");
      }
    } catch {
      fail(400, "书签网址无效");
    }
  }
  if (parent) {
    if (
      !db.prepare("SELECT id FROM browser_bookmarks WHERE id = ? AND kind = 'folder'").get(parent)
    ) {
      fail(400, "书签目录不存在");
    }
    const cycle = db
      .prepare(
        `WITH RECURSIVE tree(id) AS (
      SELECT id FROM browser_bookmarks WHERE id = ?
      UNION ALL SELECT child.id FROM browser_bookmarks child JOIN tree ON child.parent_id = tree.id
    ) SELECT id FROM tree WHERE id = ?`,
      )
      .get(bookmarkId, parent);
    if (cycle) {
      fail(400, "目录不能移入自身或子目录");
    }
  }
  db.prepare(
    "UPDATE browser_bookmarks SET title = ?, url = ?, parent_id = ?, updated_at = ? WHERE id = ?",
  ).run(title.trim(), bookmark.kind === "link" ? url : "", parent, Date.now(), bookmarkId);
  return json(res, 200, {
    bookmark: db.prepare("SELECT * FROM browser_bookmarks WHERE id = ?").get(bookmarkId),
  });
}
