export { RelayRoom } from "./room.js";
import { hash, json } from "./room.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return env.ASSETS.fetch(new Request(new URL("/remote-access.html", url), request));
    }
    const origin = request.headers.get("origin");
    if (url.pathname.startsWith("/remote/") && origin && origin !== url.origin) {
      return json({ error: "跨站请求被拒绝" }, 403);
    }
    if (url.pathname === "/rooms" && request.method === "POST") {
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "") || "";
      if (
        !env.RELAY_SECRET ||
        env.RELAY_SECRET.length < 24 ||
        (await hash(token)) !== (await hash(env.RELAY_SECRET))
      ) {
        return json({ error: "中转管理密钥不正确" }, 401);
      }
      const id = crypto.randomUUID();
      const hostToken = crypto.randomUUID() + crypto.randomUUID();
      const viewerToken = crypto.randomUUID() + crypto.randomUUID();
      const room = env.ROOMS.get(env.ROOMS.idFromName(id));
      await room.initialize(id, await hash(hostToken), await hash(viewerToken));
      return json({ id, host_token: hostToken, viewer_token: viewerToken }, 201);
    }
    const match = url.pathname.match(/^\/(remote|connect|rooms)\/([a-f0-9-]{36})(\/.*)?$/);
    if (match) {
      const room = env.ROOMS.get(env.ROOMS.idFromName(match[2]));
      const tail = match[3] || "";
      if (match[1] !== "remote" || tail === "/ws" || tail === "/auth" || tail.startsWith("/api/")) {
        return room.fetch(request);
      }
      // 远程页面复用同一个 UI 构建产物；授权信息不写入静态页面。
      return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/remote/")) {
      return json({ error: "接口不存在" }, 404);
    }
    return env.ASSETS.fetch(request);
  },
};
