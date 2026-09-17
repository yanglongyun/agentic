import WebSocket from "ws";

// 一个连接对应一个被分享的会话。Worker 的客户端 ID 只用于分发连接，不能选择本机会话。
export default function createRelay(context) {
  const links = new Map();
  let origin = "";
  let stopped = false;
  function connect(record) {
    if (stopped || !origin || links.has(record.session_id)) {
      return;
    }
    const link = {
      record,
      socket: null,
      timer: null,
      peers: new Map(),
      requests: new Map(),
      online: false,
      stopped: false,
    };
    links.set(record.session_id, link);
    function start() {
      if (stopped || link.stopped) {
        return;
      }
      const url = new URL(`/connect/${record.room_id}`, record.relay_url);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url, {
        headers: { authorization: `Bearer ${record.host_token}` },
        maxPayload: 20 * 1024 * 1024,
        handshakeTimeout: 10000,
      });
      link.socket = socket;
      const heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send('{"type":"ping"}');
        }
      }, 25000);
      heartbeat.unref();
      socket.on("open", () => {
        link.online = true;
        context.chat.publish(record.session_id, { type: "remote.status", online: true });
      });
      function send(event) {
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }
        if (socket.bufferedAmount > 8 * 1024 * 1024) {
          socket.close(1013, "中转连接拥堵");
          return;
        }
        socket.send(JSON.stringify(event));
      }
      socket.on("message", (raw) => {
        let event;
        try {
          event = JSON.parse(raw.toString());
        } catch {
          socket.close(1007, "JSON 无效");
          return;
        }
        if (event.type === "client.open") {
          if (link.peers.has(event.client_id)) {
            return;
          }
          const peer = {
            sessionId: record.session_id,
            send(data) {
              send({ type: "client.event", client_id: event.client_id, event: data });
            },
          };
          link.peers.set(event.client_id, peer);
          context.chat.attach(peer);
        } else if (event.type === "client.message") {
          const peer = link.peers.get(event.client_id);
          if (peer) {
            void context.chat.receive(peer, event.message);
          }
        } else if (event.type === "client.close") {
          const peer = link.peers.get(event.client_id);
          if (peer) {
            context.chat.detach(peer);
            link.peers.delete(event.client_id);
          }
        } else if (event.type === "http.start") {
          if (link.requests.size >= 4) {
            send({ type: "http.error", id: event.id, error: "请求过多" });
            return;
          }
          const url = new URL(event.path, "http://localhost");
          const prefix = `/api/sessions/${record.session_id}`;
          const read =
            event.method === "GET" &&
            (url.pathname === "/api/status" ||
              url.pathname === `${prefix}/messages` ||
              url.pathname === `${prefix}/compactions` ||
              new RegExp(`^${prefix}/images/[a-f0-9-]+\\.(png|jpe?g|gif|webp)$`).test(
                url.pathname,
              ));
          const upload = event.method === "POST" && url.pathname === `${prefix}/images`;
          if (!read && !upload) {
            send({ type: "http.error", id: event.id, status: 403, error: "接口未授权" });
            return;
          }
          const controller = new AbortController();
          const expiry = setTimeout(() => {
            controller.abort();
            link.requests.delete(event.id);
            send({ type: "http.error", id: event.id, error: "请求超时" });
          }, 30000);
          expiry.unref();
          link.requests.set(event.id, {
            path: url.pathname + url.search,
            method: event.method,
            chunks: [],
            size: 0,
            controller,
            expiry,
          });
        } else if (event.type === "http.chunk") {
          const request = link.requests.get(event.id);
          if (!request || request.started) {
            return;
          }
          if (typeof event.data !== "string" || event.data.length > 100000) {
            request.controller.abort();
            clearTimeout(request.expiry);
            link.requests.delete(event.id);
            send({ type: "http.error", id: event.id, error: "数据块过大" });
            return;
          }
          const chunk = Buffer.from(event.data, "base64");
          request.size += chunk.length;
          if (request.size > 14 * 1024 * 1024) {
            clearTimeout(request.expiry);
            link.requests.delete(event.id);
            send({ type: "http.error", id: event.id, error: "请求过大" });
            return;
          }
          request.chunks.push(chunk);
        } else if (event.type === "http.end") {
          const request = link.requests.get(event.id);
          if (!request || request.started) {
            return;
          }
          request.started = true;
          async function respond() {
            clearTimeout(request.expiry);
            const timer = setTimeout(() => request.controller.abort(), 30000);
            try {
              const options = {
                method: request.method,
                headers: {
                  authorization: `Bearer ${context.config.api.token}`,
                  "content-type": "application/json",
                },
                signal: request.controller.signal,
              };
              if (request.method === "POST") {
                options.body = Buffer.concat(request.chunks);
              }
              const response = await fetch(origin + request.path, options);
              send({
                type: "http.response",
                id: event.id,
                status: response.status,
                content_type: response.headers.get("content-type"),
              });
              let size = 0;
              for await (const chunk of response.body) {
                size += chunk.length;
                if (size > 20 * 1024 * 1024) {
                  throw new Error("响应过大，请缩小分页数量");
                }
                for (let offset = 0; offset < chunk.length; offset += 48 * 1024) {
                  const data = Buffer.from(chunk.subarray(offset, offset + 48 * 1024)).toString(
                    "base64",
                  );
                  await new Promise((resolve, reject) =>
                    socket.send(
                      JSON.stringify({ type: "http.data", id: event.id, data }),
                      (error) => {
                        if (error) {
                          reject(error);
                        } else {
                          resolve();
                        }
                      },
                    ),
                  );
                }
              }
              send({ type: "http.done", id: event.id });
            } catch (error) {
              send({ type: "http.error", id: event.id, error: error.message });
            } finally {
              clearTimeout(timer);
              link.requests.delete(event.id);
            }
          }
          void respond();
        } else if (event.type === "http.cancel") {
          const request = link.requests.get(event.id);
          if (request) {
            request.controller.abort();
            clearTimeout(request.expiry);
          }
          link.requests.delete(event.id);
        }
      });
      socket.on("error", () => {});
      socket.on("close", () => {
        clearInterval(heartbeat);
        link.online = false;
        for (const peer of link.peers.values()) {
          context.chat.detach(peer);
        }
        link.peers.clear();
        for (const request of link.requests.values()) {
          request.controller.abort();
          clearTimeout(request.expiry);
        }
        link.requests.clear();
        context.chat.publish(record.session_id, { type: "remote.status", online: false });
        if (!stopped && !link.stopped) {
          link.timer = setTimeout(start, 2000);
          link.timer.unref();
        }
      });
    }
    start();
  }
  function disconnect(id) {
    const link = links.get(id);
    if (!link) {
      return;
    }
    link.stopped = true;
    clearTimeout(link.timer);
    link.socket?.terminate();
    for (const peer of link.peers.values()) {
      context.chat.detach(peer);
    }
    for (const request of link.requests.values()) {
      request.controller.abort();
      clearTimeout(request.expiry);
    }
    links.delete(id);
  }
  async function disable(id) {
    const link = links.get(id);
    if (link) {
      const response = await fetch(
        new URL(`/rooms/${link.record.room_id}`, link.record.relay_url),
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${link.record.host_token}` },
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok && response.status !== 404) {
        throw new Error("远程入口关闭失败，请重试");
      }
    }
    disconnect(id);
  }
  return {
    connect,
    disable,
    online(id) {
      return links.get(id)?.online === true;
    },
    start(value, records) {
      if (origin) {
        return;
      }
      origin = value;
      for (const record of records) {
        connect(record);
      }
    },
    close() {
      stopped = true;
      for (const id of links.keys()) {
        disconnect(id);
      }
    },
  };
}
