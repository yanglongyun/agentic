import { WebSocketServer } from "ws";
import authorize from "../auth/authorize.js";
import { fail } from "../http.js";
import subscribe from "./subscribe.js";
import send from "./send.js";
import cancel from "./cancel.js";

export default function createChat(context) {
  const peers = new Set();
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
    perMessageDeflate: false,
  });
  const timer = setInterval(() => {
    for (const socket of wsServer.clients) {
      if (!socket.alive) {
        socket.terminate();
        continue;
      }
      socket.alive = false;
      socket.ping();
    }
  }, 30000);
  timer.unref();
  function attach(peer) {
    peer.subscriptions = new Set();
    peers.add(peer);
    peer.send({ type: "connected", session_id: peer.sessionId || null });
  }
  async function receive(peer, request) {
    try {
      if (
        !request ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        typeof request.request_id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(request.request_id)
      ) {
        fail(400, "请求 ID 无效");
      }
      if (
        typeof request.session_id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(request.session_id)
      ) {
        fail(400, "会话 ID 无效");
      }
      if (peer.sessionId && request.session_id !== peer.sessionId) {
        fail(403, "只能操作已授权的会话");
      }
      switch (request.type) {
        case "subscribe":
          subscribe(request, peer, context);
          return;
        case "unsubscribe":
          peer.subscriptions.delete(request.session_id);
          peer.send({
            type: "unsubscribed",
            request_id: request.request_id,
            session_id: request.session_id,
          });
          return;
        case "send":
          await send(request, peer, context);
          return;
        case "cancel":
          await cancel(request, peer, context);
          return;
        default:
          fail(400, "未知聊天操作");
      }
    } catch (error) {
      peer.send({
        type: "request.rejected",
        request_id: request?.request_id,
        session_id: request?.session_id,
        status: error.status || 500,
        error: error.message,
      });
    }
  }
  function publish(id, event) {
    const active = context.activeReplies.get(id);
    if (active && event.type === "run.event") {
      const item = event.event.item;
      const type = event.event.type;
      if (
        (item &&
          ["message", "reasoning", "function_call", "function_call_output"].includes(type)) ||
        ((type === "message" || type === "reasoning") && event.event.delta)
      ) {
        let index = active.live.findIndex((row) => row.streaming && row.item.type === type);
        let key = `${active.id}:${event.sequence}`;
        let value = item;
        if (index >= 0) {
          key = active.live[index].key;
        }
        if (!item) {
          key = `${active.id}:delta:${type}`;
          let text = event.event.delta;
          if (index >= 0) {
            const previous = active.live[index].item;
            text =
              (type === "message" ? previous.content[0].text : previous.summary[0].text) + text;
          }
          if (type === "message") {
            value = {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text }],
            };
          } else {
            value = { type: "reasoning", summary: [{ type: "summary_text", text }] };
          }
        }
        const row = {
          id: 0,
          key,
          item: value,
          sequence: event.sequence,
          created_at: event.created_at || Date.now(),
          streaming: !item,
        };
        if (index >= 0) {
          active.live[index] = row;
        } else {
          active.live.push(row);
        }
      }
    }
    if (active && event.type === "messages.saved") {
      active.live = active.live.filter(
        (row) => !event.messages.some((saved) => saved.sequence === row.sequence),
      );
    }
    for (const peer of peers) {
      if (
        peer.subscriptions.has(id) ||
        (["session.updated", "session.deleted"].includes(event.type) && !peer.sessionId)
      ) {
        peer.send({ ...event, session_id: id });
      }
    }
  }
  function upgrade(req, socket, head) {
    try {
      if (new URL(req.url, "http://localhost").pathname !== "/api/chat") {
        fail(404, "接口不存在");
      }
      authorize(req, context);
      if (
        req.headers.origin &&
        new URL(req.headers.origin).host.toLowerCase() !== req.headers.host?.toLowerCase()
      ) {
        fail(403, "跨站连接被拒绝");
      }
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        const peer = {
          send(event) {
            if (ws.readyState !== 1) {
              return;
            }
            if (ws.bufferedAmount > 2 * 1024 * 1024) {
              ws.close(1013, "客户端接收过慢，请重新连接");
              return;
            }
            ws.send(JSON.stringify(event));
          },
        };
        attach(peer);
        ws.alive = true;
        ws.on("pong", () => {
          ws.alive = true;
        });
        ws.on("message", (raw, binary) => {
          if (binary) {
            ws.close(1003, "只接受 JSON 文本");
            return;
          }
          let request;
          try {
            request = JSON.parse(raw.toString());
          } catch {
            ws.close(1007, "JSON 无效");
            return;
          }
          void receive(peer, request);
        });
        ws.on("close", () => peers.delete(peer));
        ws.on("error", () => {});
      });
    } catch (error) {
      socket.end(`HTTP/1.1 ${error.status || 400} Rejected\r\nConnection: close\r\n\r\n`);
    }
  }
  return {
    attach,
    receive,
    publish,
    upgrade,
    detach(peer) {
      peers.delete(peer);
    },
    close() {
      clearInterval(timer);
      for (const socket of wsServer.clients) {
        socket.terminate();
      }
      wsServer.close();
      peers.clear();
    },
  };
}
