import { execute } from "../../computer/index.js";

export default async function computer(args, config, signal) {
  if (typeof args.code !== "string" || !args.code.trim()) {
    throw new Error("缺少 code");
  }
  if (typeof args.summary !== "string" || !args.summary.trim()) {
    throw new Error("缺少 summary");
  }
  return execute(args.code, config, signal);
}
