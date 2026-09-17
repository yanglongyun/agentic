import { fail } from "../http.js";
export default async function cancel(request, peer, context) {
  const id = request.session_id;
  if (!context.db.prepare("SELECT id FROM sessions WHERE id = ?").get(id)) {
    fail(404, "会话不存在");
  }
  if (typeof request.run_id !== "string" || !request.run_id) {
    fail(400, "缺少运行 ID");
  }
  const active = context.activeReplies.get(id);
  if (active && active.id === request.run_id) {
    active.controller.abort(new DOMException("已停止", "AbortError"));
    await active.done;
  }
  peer.send({
    type: "request.accepted",
    request_id: request.request_id,
    session_id: id,
    operation: "cancel",
  });
}
