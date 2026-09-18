import bookmarks from "./bookmarks/index.js";
import history from "./history/index.js";
import pages from "./pages/index.js";
import { fail } from "../http.js";
export default function browser(req, res, parts, context) {
  switch (parts[0]) {
    case "pages":
      return pages(req, res, parts.slice(1), context);
    case "bookmarks":
      return bookmarks(req, res, parts.slice(1), context);
    case "history":
      return history(req, res, parts.slice(1), context);
    default:
      fail(404, "接口不存在");
  }
}
