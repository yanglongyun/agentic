import get from "./get.js";
import { fail } from "../../../../http.js";
export default function image(req, res, parts, context, id, name) {
  if (parts.length) {
    fail(404, "图片不存在");
  }
  if (req.method !== "GET") {
    fail(405, "不支持的方法");
  }
  return get(req, res, context, id, name);
}
