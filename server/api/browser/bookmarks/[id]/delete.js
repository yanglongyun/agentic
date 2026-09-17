import { json } from "../../../http.js";
export default function remove(req, res, { db, bookmarkId }) {
  db.prepare(
    `WITH RECURSIVE tree(id) AS (
    SELECT id FROM browser_bookmarks WHERE id = ?
    UNION ALL SELECT child.id FROM browser_bookmarks child JOIN tree ON child.parent_id = tree.id
  ) DELETE FROM browser_bookmarks WHERE id IN (SELECT id FROM tree)`,
  ).run(bookmarkId);
  return json(res, 200, { ok: true });
}
