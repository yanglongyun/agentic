import { body, json, fail } from "../../http.js";
export default async function post(req, res, { db }) {
  const {
    url,
    title = "",
    icon = "",
    visit = true,
  } = await body(req, ["url", "title", "icon", "visit"]);
  if (
    typeof url !== "string" ||
    url.length > 8192 ||
    typeof title !== "string" ||
    title.length > 2000 ||
    typeof icon !== "string" ||
    icon.length > 8192 ||
    typeof visit !== "boolean"
  ) {
    fail(400, "历史记录无效");
  }
  try {
    if (!["http:", "https:"].includes(new URL(url).protocol)) {
      fail(400, "网址无效");
    }
  } catch {
    fail(400, "网址无效");
  }
  if (visit) {
    db.prepare(
      `INSERT INTO browser_history (url, title, icon, visits, visited_at) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(url) DO UPDATE SET title = excluded.title, icon = CASE WHEN excluded.icon != '' THEN excluded.icon ELSE browser_history.icon END, visits = visits + 1, visited_at = excluded.visited_at`,
    ).run(url, title, icon, Date.now());
  } else {
    db.prepare(
      "UPDATE browser_history SET title = ?, icon = CASE WHEN ? != '' THEN ? ELSE icon END WHERE url = ?",
    ).run(title, icon, icon, url);
  }
  return json(res, 200, { ok: true });
}
