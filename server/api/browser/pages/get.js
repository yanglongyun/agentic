import { json } from "../../http.js";

export default function get(req, res, { db }) {
  const sessionId = new URL(req.url, "http://localhost").searchParams.get("session_id");
  let pages;
  if (sessionId === null) {
    pages = db.prepare("SELECT * FROM browser_pages ORDER BY session_id, position, id").all();
  } else {
    pages = db
      .prepare("SELECT * FROM browser_pages WHERE session_id = ? ORDER BY position, id")
      .all(sessionId);
  }
  return json(res, 200, { pages });
}
