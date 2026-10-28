import { json } from "../http.js";

// 官方发布的新东西和每条的处理状态。出厂就带着的（included）不给界面。
export default async function get(req, res, context) {
  if (!context.launcher) {
    return json(res, 200, { items: [] });
  }
  const { items } = await context.launcher.call("news.list");
  return json(res, 200, { items: items.filter((entry) => entry.status !== "included") });
}
