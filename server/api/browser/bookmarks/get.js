import { json } from "../../http.js";
export default function get(req, res, { db }) {
  const bookmarks = db
    .prepare("SELECT * FROM browser_bookmarks ORDER BY kind, created_at, id")
    .all();
  return json(res, 200, { bookmarks });
}
