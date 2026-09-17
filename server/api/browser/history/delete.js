import { json } from "../../http.js";
export default function remove(req, res, { db }) {
  const url = new URL(req.url, "http://localhost").searchParams.get("url");
  if (url) {
    db.prepare("DELETE FROM browser_history WHERE url = ?").run(url);
  } else {
    db.prepare("DELETE FROM browser_history").run();
  }
  return json(res, 200, { ok: true });
}
