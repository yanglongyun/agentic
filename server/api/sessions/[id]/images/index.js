import post from "./post.js";
import image from "./[name]/index.js";
import { fail } from "../../../http.js";
export default function images(req, res, parts, context, id) {
  if (parts.length) {
    return image(req, res, parts.slice(1), context, id, parts[0]);
  }
  if (req.method === "POST") {
    return post(req, res, context, id);
  }
  fail(405, "不支持的方法");
}
