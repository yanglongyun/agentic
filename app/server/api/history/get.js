import { json } from "../http.js";

// 改动记录：launcher 的快照史，新的在前。不经 launcher 跑时没有快照，available 为 false。
export default async function get(req, res, context) {
  if (!context.launcher) {
    return json(res, 200, { available: false, entries: [] });
  }
  const { entries } = await context.launcher.call("history.list", { limit: 100 });
  return json(res, 200, { available: true, entries });
}
