import { json, fail } from "../http.js";

// 在访达 / 资源管理器里打开浏览器插件所在的文件夹，用户照着说明在浏览器里加载它。
export default async function post(req, res, context) {
  if (!context.launcher) {
    fail(409, "没有经 launcher 运行");
  }
  const result = await context.launcher.call("extension.reveal");
  return json(res, 200, result);
}
