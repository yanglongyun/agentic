import { json } from "../../../http.js";
export default function get(req, res, context, id) {
  const record = context.db.prepare("SELECT * FROM remote_sessions WHERE session_id = ?").get(id);
  if (!record) {
    return json(res, 200, { enabled: false });
  }
  return json(res, 200, {
    enabled: true,
    online: context.relay.online(id),
    url: `${record.relay_url}/remote/${record.room_id}#${record.viewer_token}`,
  });
}
