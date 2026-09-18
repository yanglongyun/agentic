import { body, json, fail } from "../../http.js";

export default async function put(req, res, { db }) {
  const { session_id, pages } = await body(req, ["session_id", "pages"], 2 * 1024 * 1024);
  if (typeof session_id !== "string" || !Array.isArray(pages)) {
    fail(400, "标签记录无效");
  }
  // 空会话 ID 表示尚未发送消息的草稿。
  if (session_id && !db.prepare("SELECT id FROM sessions WHERE id = ?").get(session_id)) {
    fail(404, "会话不存在");
  }
  const ids = new Set();
  let activeCount = 0;
  for (const page of pages) {
    if (
      !page ||
      typeof page.id !== "string" ||
      !page.id ||
      page.id.length > 128 ||
      typeof page.url !== "string" ||
      page.url.length > 8192 ||
      typeof page.title !== "string" ||
      page.title.length > 2000 ||
      typeof page.icon !== "string" ||
      page.icon.length > 65536 ||
      typeof page.active !== "boolean" ||
      ids.has(page.id)
    ) {
      fail(400, "标签记录无效");
    }
    try {
      if (page.url !== "about:blank" && !["http:", "https:"].includes(new URL(page.url).protocol)) {
        fail(400, "网址无效");
      }
    } catch {
      fail(400, "网址无效");
    }
    ids.add(page.id);
    if (page.active) {
      activeCount += 1;
    }
    const existing = db.prepare("SELECT session_id FROM browser_pages WHERE id = ?").get(page.id);
    if (existing && existing.session_id !== session_id) {
      fail(409, "标签属于其他对话");
    }
  }
  if (activeCount !== (pages.length ? 1 : 0)) {
    fail(400, "必须选中一个标签");
  }
  const now = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    // 一次保存一个对话的标签集合，关闭和排序与元数据一起提交。
    const existing = db
      .prepare("SELECT id FROM browser_pages WHERE session_id = ?")
      .all(session_id);
    for (const page of existing) {
      if (!ids.has(page.id)) {
        db.prepare("DELETE FROM browser_pages WHERE id = ?").run(page.id);
      }
    }
    for (let position = 0; position < pages.length; position++) {
      const page = pages[position];
      db.prepare(
        `INSERT INTO browser_pages (id, session_id, url, title, icon, position, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET url = excluded.url, title = excluded.title, icon = excluded.icon,
          position = excluded.position, active = excluded.active, updated_at = excluded.updated_at`,
      ).run(
        page.id,
        session_id,
        page.url,
        page.title,
        page.icon,
        position,
        page.active ? 1 : 0,
        now,
        now,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return json(res, 200, { ok: true });
}
