import createChat from "./chat/index.js";
import createRelay from "../relay/index.js";
import auth from "./auth/index.js";
import authorize from "./auth/authorize.js";
import sessions from "./sessions/index.js";
import config from "./config/index.js";
import status from "./status/index.js";
import browser from "./browser/index.js";
import images from "./images/index.js";
import { fail } from "./http.js";

export default function createApi(context) {
  // 只记录正在执行的请求，供取消和服务关闭时清理。
  context.activeReplies = new Map();
  context.chat = createChat(context);
  context.relay = createRelay(context);

  async function route(req, res, parts) {
    const name = parts[0];
    const rest = parts.slice(1);
    if (name === "auth") {
      return auth(req, res, rest, context);
    }
    authorize(req, context);

    switch (name) {
      case "sessions":
        return sessions(req, res, rest, context);
      case "config":
        return config(req, res, rest, context);
      case "status":
        return status(req, res, rest, context);
      case "browser":
        return browser(req, res, rest, context);
      case "images":
        return images(req, res, rest, context);
      default:
        fail(404, "接口不存在");
    }
  }

  async function close() {
    context.relay.close();
    context.chat.close();
    const requests = [...context.activeReplies.values()];
    for (const request of requests) {
      request.controller.abort();
    }
    await Promise.all(requests.map((request) => request.done));
  }

  return {
    route,
    close,
    upgrade: context.chat.upgrade,
    start(origin) {
      context.relay.start(origin, context.db.prepare("SELECT * FROM remote_sessions").all());
    },
  };
}
