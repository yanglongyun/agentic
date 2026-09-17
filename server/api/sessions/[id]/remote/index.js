import get from "./get.js";
import post from "./post.js";
import remove from "./delete.js";
import { fail } from "../../../http.js";
export default function remote(req, res, parts, context, id) {
  if (parts.length) {
    fail(404, "接口不存在");
  }
  if (!context.db.prepare("SELECT id FROM sessions WHERE id = ?").get(id)) {
    fail(404, "会话不存在");
  }
  switch (req.method) {
    case "GET":
      return get(req, res, context, id);
    case "POST":
      return post(req, res, context, id);
    case "DELETE":
      return remove(req, res, context, id);
    default:
      fail(405, "不支持的方法");
  }
}
