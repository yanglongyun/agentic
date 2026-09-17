import get from "./get.js";
import post from "./post.js";
import item from "./[id]/index.js";
import importing from "./import/index.js";
import { fail } from "../../http.js";
export default function bookmarks(req, res, parts, context) {
  if (parts[0] === "import") {
    return importing(req, res, parts.slice(1), context);
  }
  if (parts.length) {
    return item(req, res, parts.slice(1), { ...context, bookmarkId: parts[0] });
  }
  switch (req.method) {
    case "GET":
      return get(req, res, context);
    case "POST":
      return post(req, res, context);
    default:
      fail(405, "不支持的方法");
  }
}
