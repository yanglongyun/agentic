import patch from "./patch.js";
import { fail } from "../../http.js";

export default async function item(req, res, parts, context, id) {
  if (parts.length > 0) {
    fail(404, "接口不存在");
  }
  switch (req.method) {
    case "PATCH":
      return patch(req, res, context, id);
    default:
      fail(405, "不支持的方法");
  }
}
