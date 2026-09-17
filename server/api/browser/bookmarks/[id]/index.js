import patch from "./patch.js";
import remove from "./delete.js";
import { fail } from "../../../http.js";
export default function item(req, res, parts, context) {
  if (parts.length) {
    fail(404, "接口不存在");
  }
  switch (req.method) {
    case "PATCH":
      return patch(req, res, context);
    case "DELETE":
      return remove(req, res, context);
    default:
      fail(405, "不支持的方法");
  }
}
