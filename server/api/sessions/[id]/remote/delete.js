import { json } from "../../../http.js";
export default async function remove(req, res, context, id) {
  await context.relay.disable(id);
  context.db.prepare("DELETE FROM remote_sessions WHERE session_id = ?").run(id);
  context.chat.publish(id, { type: "remote.status", online: false, enabled: false });
  return json(res, 200, { enabled: false });
}
