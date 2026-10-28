import { body, json, fail } from "../../http.js";

// 界面上只能把一条新东西标成「不要」（skipped）或改回「还没决定」（new）；「加上了」由 agent 加完后记。
export default async function patch(req, res, context, id) {
  const { status } = await body(req, ["status"]);
  if (!["skipped", "new"].includes(status)) {
    fail(400, "status 只能是 skipped 或 new");
  }
  if (!context.launcher) {
    fail(409, "没有经 launcher 运行");
  }
  await context.launcher.call("news.mark", { id, status });
  return json(res, 200, { id, status });
}
