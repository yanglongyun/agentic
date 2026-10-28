import { body, json, fail } from "../../http.js";

// 退回到某次改动之后的样子。launcher 换好代码后整个应用重启，窗口会重新加载。
export default async function post(req, res, context) {
  const { oid } = await body(req, ["oid"]);
  if (typeof oid !== "string" || !/^[0-9a-f]{7,40}$/.test(oid)) {
    fail(400, "oid 必须是版本号");
  }
  if (!context.launcher) {
    fail(409, "没有经 launcher 运行，不能退回");
  }
  const result = await context.launcher.call("history.rollback", { oid });
  return json(res, 200, result);
}
