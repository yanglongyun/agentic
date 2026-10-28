import get from "./get.js";
import rollback from "./rollback/index.js";
import { fail } from "../http.js";

export default async function history(req, res, parts, context) {
  if (parts[0] === "rollback") {
    return rollback(req, res, parts.slice(1), context);
  }
  if (parts.length > 0) {
    fail(404, "接口不存在");
  }
  switch (req.method) {
    case "GET":
      return get(req, res, context);
    default:
      fail(405, "不支持的方法");
  }
}
