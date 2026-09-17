import { json, fail } from "../../http.js";
export default function get(req, res, { db }) {
  const search = new URL(req.url, "http://localhost").searchParams;
  const query = search.get("query") || "";
  const offset = Number(search.get("offset") || 0);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    fail(400, "分页位置无效");
  }
  const history = db
    .prepare(
      "SELECT * FROM browser_history WHERE instr(lower(title), lower(?)) > 0 OR instr(lower(url), lower(?)) > 0 ORDER BY visited_at DESC LIMIT 100 OFFSET ?",
    )
    .all(query, query, offset);
  const { total } = db
    .prepare(
      "SELECT COUNT(*) AS total FROM browser_history WHERE instr(lower(title), lower(?)) > 0 OR instr(lower(url), lower(?)) > 0",
    )
    .get(query, query);
  return json(res, 200, { history, total });
}
