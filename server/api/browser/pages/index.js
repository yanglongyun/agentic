import get from "./get.js";
import put from "./put.js";
import claim from "./claim/index.js";
import { fail } from "../../http.js";

export default function pages(req, res, parts, context) {
  if (parts[0] === "claim") {
    return claim(req, res, parts.slice(1), context);
  }
  if (parts.length) {
    fail(404, "接口不存在");
  }
  switch (req.method) {
    case "GET":
      return get(req, res, context);
    case "PUT":
      return put(req, res, context);
    default:
      fail(405, "不支持的方法");
  }
}
