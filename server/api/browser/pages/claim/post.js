import { body, json, fail } from "../../../http.js";

export default async function post(req, res, { db }) {
  const { session_id } = await body(req, ["session_id"]);
  if (typeof session_id !== "string" || !session_id) {
    fail(400, "对话 ID 无效");
  }
  if (!db.prepare("SELECT id FROM sessions WHERE id = ?").get(session_id)) {
    fail(404, "会话不存在");
  }
  if (db.prepare("SELECT id FROM browser_pages WHERE session_id = ?").get(session_id)) {
    fail(409, "对话已有网页");
  }
  db.prepare("UPDATE browser_pages SET session_id = ?, updated_at = ? WHERE session_id = ''").run(
    session_id,
    Date.now(),
  );
  return json(res, 200, { ok: true });
}
