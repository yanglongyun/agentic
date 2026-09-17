import { remoteRoot } from "../lib/remote";

export interface Packet {
  type: string;
  request_id?: string;
  session_id?: string;
  [key: string]: unknown;
}
interface Pending {
  packet: Packet;
  resolve: (value: Packet) => void;
  reject: (error: Error) => void;
}
let socket: WebSocket | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let stopped = true;
let sessionId = "";
let subscribed = false;
let receive: (packet: Packet) => void;
let status: (online: boolean) => void;
const pending = new Map<string, Pending>();
function write(packet: Packet) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(packet));
  }
}
function flush() {
  if (!subscribed) {
    return;
  }
  for (const request of pending.values()) {
    write(request.packet);
  }
}
function subscribe() {
  subscribed = false;
  if (sessionId) {
    write({ type: "subscribe", request_id: crypto.randomUUID(), session_id: sessionId });
  }
}
function connect() {
  if (stopped) {
    return;
  }
  const url = new URL(remoteRoot ? `${remoteRoot}/ws` : "/api/chat", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const next = new WebSocket(url);
  socket = next;
  next.onmessage = (message) => {
    if (socket !== next) {
      return;
    }
    const packet = JSON.parse(message.data) as Packet;
    if (packet.type === "connected") {
      if (remoteRoot) {
        sessionId = packet.session_id as string;
      }
      subscribe();
      status(true);
    }
    if (remoteRoot && packet.type === "remote.status" && packet.online === false) {
      subscribed = false;
      status(false);
    }
    if (packet.type === "subscribed" && packet.session_id === sessionId) {
      subscribed = true;
    }
    receive(packet);
    if (packet.type === "subscribed") {
      flush();
    }
    const request = packet.request_id ? pending.get(packet.request_id) : undefined;
    if (request && ["request.accepted", "request.rejected"].includes(packet.type)) {
      pending.delete(packet.request_id!);
      if (packet.type === "request.rejected") {
        request.reject(new Error(String(packet.error)));
      } else {
        request.resolve(packet);
      }
    }
  };
  next.onopen = () => {
    if (remoteRoot) {
      heartbeat = setInterval(() => write({ type: "ping" }), 25000);
    }
  };
  next.onclose = (event) => {
    if (socket !== next) {
      return;
    }
    clearInterval(heartbeat);
    subscribed = false;
    status(false);
    if (event?.code === 1008) {
      stopped = true;
      receive({ type: "remote.error", error: event.reason || "远程访问已关闭" });
      for (const request of pending.values()) {
        request.reject(new Error("远程访问已关闭"));
      }
      pending.clear();
      return;
    }
    if (!stopped) {
      timer = setTimeout(connect, 1500);
    }
  };
  next.onerror = () => next.close();
}
export function startSocket(onPacket: typeof receive, onStatus: typeof status) {
  receive = onPacket;
  status = onStatus;
  if (!stopped) {
    return;
  }
  stopped = false;
  connect();
}
export function selectSession(id: string) {
  if (sessionId && sessionId !== id) {
    write({ type: "unsubscribe", request_id: crypto.randomUUID(), session_id: sessionId });
  }
  sessionId = id;
  subscribe();
}
export function requestSocket(packet: Packet): Promise<Packet> {
  const requestId = packet.request_id || crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const request = { packet: { ...packet, request_id: requestId }, resolve, reject };
    pending.set(requestId, request);
    if (subscribed) {
      write(request.packet);
    }
  });
}
export function stopSocket() {
  stopped = true;
  clearTimeout(timer);
  clearInterval(heartbeat);
  const previous = socket;
  socket = null;
  previous?.close();
  for (const request of pending.values()) {
    request.reject(new Error("已退出会话连接"));
  }
  pending.clear();
  sessionId = "";
  subscribed = false;
}
