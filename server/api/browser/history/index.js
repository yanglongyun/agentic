import get from "./get.js";
import post from "./post.js";
import remove from "./delete.js";
import { fail } from "../../http.js";
export default function history(req, res, parts, context) {
  if (parts.length) {
    fail(404, "接口不存在");
  }
  switch (req.method) {
    case "GET":
      return get(req, res, context);
    case "POST":
      return post(req, res, context);
    case "DELETE":
      return remove(req, res, context);
    default:
      fail(405, "不支持的方法");
  }
}
