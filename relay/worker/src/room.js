import { DurableObject } from "cloudflare:workers";

export async function hash(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function json(value, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

const LIMIT = 14 * 1024 * 1024;
function encode(bytes) {
  let text = "";
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return btoa(text);
}
function decode(text) {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

// 一个 Durable Object 只连接一个本地会话。历史、模型调用和工具执行都留在客户端。
export class RelayRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pending = new Map();
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
    );
  }
  async initialize(id, host, viewer) {
    await this.ctx.storage.put("room", { id, host, viewer, revoked: false });
  }
  host() {
    return this.ctx.getWebSockets("host").find((socket) => socket.readyState === 1);
  }
  send(socket, event) {
    if (socket?.readyState === 1) {
      socket.send(JSON.stringify(event));
    }
  }
  async fetch(request) {
    const room = await this.ctx.storage.get("room");
    if (!room || room.revoked) {
      return json({ error: "远程入口不存在或已关闭" }, 404);
    }
    const url = new URL(request.url);
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") || "";
    if (url.pathname === `/rooms/${room.id}` && request.method === "DELETE") {
      if ((await hash(bearer)) !== room.host) {
        return json({ error: "无权关闭入口" }, 401);
      }
      await this.ctx.storage.put("room", { ...room, revoked: true });
      for (const socket of this.ctx.getWebSockets()) {
        socket.close(1008, "远程入口已关闭");
      }
      this.failPending("远程入口已关闭");
      return json({ ok: true });
    }
    if (url.pathname === `/connect/${room.id}`) {
      if ((await hash(bearer)) !== room.host) {
        return json({ error: "主机凭据不正确" }, 401);
      }
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "需要 WebSocket" }, 426);
      }
      const old = this.host();
      if (old) {
        old.close(1012, "主机重新连接");
        this.failPending("主机重新连接");
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server, ["host"]);
      server.serializeAttachment({ role: "host" });
      for (const viewer of this.ctx.getWebSockets("viewer")) {
        this.send(viewer, { type: "remote.status", online: true });
        this.send(server, { type: "client.open", client_id: viewer.deserializeAttachment().id });
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) {
      return json({ error: "跨站请求被拒绝" }, 403);
    }
    if (url.pathname === `/remote/${room.id}/auth` && request.method === "POST") {
      if (Number(request.headers.get("content-length")) > 1024) {
        return json({ error: "请求过大" }, 413);
      }
      const text = await request.text();
      if (text.length > 1024) {
        return json({ error: "请求过大" }, 413);
      }
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return json({ error: "JSON 无效" }, 400);
      }
      if (typeof body.token !== "string" || (await hash(body.token)) !== room.viewer) {
        return json({ error: "访问凭据不正确" }, 401);
      }
      let cookie = `relay=${body.token}; Path=/remote/${room.id}; HttpOnly; SameSite=Strict; Max-Age=2592000`;
      if (url.protocol === "https:") {
        cookie += "; Secure";
      }
      return new Response('{"ok":true}', {
        headers: {
          "content-type": "application/json",
          "set-cookie": cookie,
          "cache-control": "no-store",
        },
      });
    }
    const token =
      (request.headers.get("cookie") || "")
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("relay="))
        ?.slice(6) || "";
    if ((await hash(token)) !== room.viewer) {
      return json({ error: "请使用完整远程链接打开" }, 401);
    }
    if (url.pathname === `/remote/${room.id}/ws`) {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "需要 WebSocket" }, 426);
      }
      if (this.ctx.getWebSockets("viewer").length >= 8) {
        return json({ error: "连接数已满" }, 429);
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      const id = crypto.randomUUID();
      this.ctx.acceptWebSocket(server, ["viewer", id]);
      server.serializeAttachment({ role: "viewer", id });
      this.send(server, { type: "remote.status", online: Boolean(this.host()) });
      this.send(this.host(), { type: "client.open", client_id: id });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname.startsWith(`/remote/${room.id}/api/`)) {
      return this.proxy(request, room.id);
    }
    return json({ error: "接口不存在" }, 404);
  }
  async proxy(request, roomId) {
    const host = this.host();
    if (!host) {
      return json({ error: "本地客户端离线" }, 503);
    }
    if (this.pending.size >= 4) {
      return json({ error: "请求过多" }, 429);
    }
    if (!["GET", "POST"].includes(request.method)) {
      return json({ error: "接口未授权" }, 403);
    }
    const id = crypto.randomUUID();
    const url = new URL(request.url);
    let finish;
    const result = new Promise((resolve) => {
      finish = resolve;
    });
    const pending = {
      finish,
      chunks: [],
      size: 0,
      status: 200,
      contentType: "application/json",
      timer: null,
    };
    this.pending.set(id, pending);
    pending.timer = setTimeout(() => {
      this.send(host, { type: "http.cancel", id });
      this.complete(id, json({ error: "本地客户端响应超时" }, 504));
    }, 30000);
    this.send(host, {
      type: "http.start",
      id,
      path: url.pathname.slice(`/remote/${roomId}`.length) + url.search,
      method: request.method,
    });
    try {
      let size = 0;
      if (request.body) {
        for await (const chunk of request.body) {
          size += chunk.length;
          if (size > LIMIT) {
            throw new Error("上传内容过大");
          }
          for (let offset = 0; offset < chunk.length; offset += 48 * 1024) {
            if (!this.pending.has(id)) {
              return result;
            }
            this.send(host, {
              type: "http.chunk",
              id,
              data: encode(chunk.subarray(offset, offset + 48 * 1024)),
            });
          }
        }
      }
      this.send(host, { type: "http.end", id });
    } catch (error) {
      this.send(host, { type: "http.cancel", id });
      this.complete(id, json({ error: error.message }, 413));
    }
    return result;
  }
  complete(id, response) {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.finish(response);
  }
  failPending(error) {
    for (const id of this.pending.keys()) {
      this.complete(id, json({ error }, 503));
    }
  }
  webSocketMessage(socket, raw) {
    const attachment = socket.deserializeAttachment();
    const limit = attachment.role === "host" ? 24 * 1024 * 1024 : 256 * 1024;
    if (typeof raw !== "string" || raw.length > limit) {
      socket.close(1009, "消息过大");
      return;
    }
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      socket.close(1007, "JSON 无效");
      return;
    }
    if (attachment.role === "viewer") {
      const host = this.host();
      if (!host) {
        this.send(socket, { type: "remote.status", online: false });
        return;
      }
      this.send(host, { type: "client.message", client_id: attachment.id, message: event });
      return;
    }
    if (socket !== this.host()) {
      return;
    }
    if (event.type === "client.event") {
      for (const viewer of this.ctx.getWebSockets(event.client_id)) {
        this.send(viewer, event.event);
      }
      return;
    }
    const pending = this.pending.get(event.id);
    if (!pending) {
      return;
    }
    if (event.type === "http.response") {
      pending.status = event.status;
      pending.contentType = event.content_type || "application/octet-stream";
    } else if (event.type === "http.data") {
      const bytes = decode(event.data);
      pending.size += bytes.length;
      if (pending.size > 20 * 1024 * 1024) {
        this.send(socket, { type: "http.cancel", id: event.id });
        this.complete(event.id, json({ error: "响应过大" }, 413));
        return;
      }
      pending.chunks.push(bytes);
    } else if (event.type === "http.done") {
      this.complete(
        event.id,
        new Response(new Blob(pending.chunks), {
          status: pending.status,
          headers: {
            "content-type": pending.contentType,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        }),
      );
    } else if (event.type === "http.error") {
      this.complete(event.id, json({ error: event.error }, event.status || 502));
    }
  }
  webSocketClose(socket) {
    // 1006 是断线通知码，不能作为关闭帧发送。
    socket.close(1000, "连接已关闭");
    const attachment = socket.deserializeAttachment();
    if (attachment.role === "viewer") {
      this.send(this.host(), { type: "client.close", client_id: attachment.id });
    } else if (!this.host()) {
      this.failPending("本地客户端离线");
      for (const viewer of this.ctx.getWebSockets("viewer")) {
        this.send(viewer, { type: "remote.status", online: false });
      }
    }
  }
  webSocketError(socket) {
    socket.close(1011, "连接异常");
  }
}
