import { fail } from "../http.js";
export default function subscribe(request, peer, context) {
  const id = request.session_id;
  const session = context.db
    .prepare(
      `SELECT sessions.*, (SELECT item FROM messages WHERE session_id = sessions.id ORDER BY id LIMIT 1) AS first FROM sessions WHERE id = ?`,
    )
    .get(id);
  if (!session) {
    fail(404, "会话不存在");
  }
  const rows = context.db
    .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 61")
    .all(id);
  const messages = rows
    .slice(0, 60)
    .reverse()
    .map((row) => ({
      ...row,
      item: JSON.parse(row.item),
      usage: row.usage ? JSON.parse(row.usage) : null,
    }));
  const compactions = context.db
    .prepare("SELECT * FROM compactions WHERE session_id = ? ORDER BY id")
    .all(id);
  const active = context.activeReplies.get(id);
  const last = context.db
    .prepare(
      "SELECT id, result FROM chat_requests WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(id);
  let run = null;
  if (active) {
    run = { id: active.id, status: "running", live: active.live, error: active.error };
  } else if (last) {
    run = {
      id: last.id,
      ...(last.result
        ? JSON.parse(last.result)
        : { status: "incomplete", error: "本地服务曾中断，本轮未完成" }),
      live: [],
    };
  }
  let preview = "";
  if (session.first) {
    preview =
      JSON.parse(session.first)
        .content.map((part) => part.text || "")
        .join("")
        .replace(/\s+/g, " ")
        .slice(0, 60) || "[图片]";
  }
  delete session.first;
  peer.subscriptions.add(id);
  peer.send({
    type: "subscribed",
    request_id: request.request_id,
    session_id: id,
    snapshot: {
      session: { ...session, preview, running: Boolean(active) },
      messages,
      compactions,
      has_more: rows.length > 60,
      run,
      status: {
        model: context.config.model,
        model_ready: Boolean(context.config.url && context.config.model && context.config.key),
        workdir: context.config.workdir,
      },
    },
  });
}
