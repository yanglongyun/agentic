import { body, json, fail } from "../../../http.js";
export default async function post(req, res, context, id) {
  const { url, key } = await body(req, ["url", "key"]);
  if (typeof url !== "string" || typeof key !== "string" || key.length < 24) {
    fail(400, "请填写 Worker 地址和至少 24 位的部署密钥");
  }
  let address;
  try {
    address = new URL(url);
  } catch {
    fail(400, "Worker 地址无效");
  }
  if (
    address.username ||
    address.password ||
    (address.protocol !== "https:" &&
      !(address.protocol === "http:" && ["localhost", "127.0.0.1"].includes(address.hostname)))
  ) {
    fail(400, "Worker 必须使用 HTTPS，本机测试可使用 HTTP");
  }
  if (context.db.prepare("SELECT session_id FROM remote_sessions WHERE session_id = ?").get(id)) {
    fail(409, "此会话已开启远程，请先关闭");
  }
  const response = await fetch(new URL("/rooms", address), {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    fail(502, `Worker 拒绝注册：HTTP ${response.status}`);
  }
  const room = await response.json();
  if (
    !/^[a-f0-9-]{36}$/.test(room.id) ||
    typeof room.host_token !== "string" ||
    typeof room.viewer_token !== "string"
  ) {
    fail(502, "Worker 返回的数据无效");
  }
  const record = {
    session_id: id,
    room_id: room.id,
    relay_url: address.origin,
    host_token: room.host_token,
    viewer_token: room.viewer_token,
    created_at: Date.now(),
  };
  try {
    if (!context.db.prepare("SELECT id FROM sessions WHERE id = ?").get(id)) {
      fail(404, "会话不存在");
    }
    if (context.db.prepare("SELECT session_id FROM remote_sessions WHERE session_id = ?").get(id)) {
      fail(409, "此会话已开启远程");
    }
    context.db
      .prepare(
        "INSERT INTO remote_sessions (session_id, room_id, relay_url, host_token, viewer_token, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, room.id, address.origin, room.host_token, room.viewer_token, record.created_at);
  } catch (error) {
    await fetch(new URL(`/rooms/${room.id}`, address), {
      method: "DELETE",
      headers: { authorization: `Bearer ${room.host_token}` },
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
    throw error;
  }
  context.relay.connect(record);
  return json(res, 201, {
    enabled: true,
    online: false,
    url: `${address.origin}/remote/${room.id}#${room.viewer_token}`,
  });
}
