import get from "./get.js";
import item from "./[id]/index.js";
import { fail } from "../http.js";

export default async function news(req, res, parts, context) {
  if (parts.length > 0) {
    return item(req, res, parts.slice(1), context, parts[0]);
  }
  switch (req.method) {
    case "GET":
      return get(req, res, context);
    default:
      fail(405, "不支持的方法");
  }
}
