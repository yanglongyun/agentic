import post from "./post.js";
import { fail } from "../../../http.js";

export default function claim(req, res, parts, context) {
  if (parts.length) {
    fail(404, "接口不存在");
  }
  if (req.method !== "POST") {
    fail(405, "不支持的方法");
  }
  return post(req, res, context);
}
