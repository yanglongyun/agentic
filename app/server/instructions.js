import fs from "node:fs";
import path from "node:path";
import { renderPrompt } from "./config.js";

const read = (file, limit = 40000) => {
  try {
    return fs.readFileSync(file, "utf8").slice(0, limit);
  } catch {
    return "";
  }
};

// 主模型的指令：设置里的提示词 + launcher 契约 + AGENT.md + 回滚通知 + 还没处理的新东西。每一轮现读，契约和 AGENT.md 都可能刚被改过。
export function buildInstructions(config, workspace) {
  const parts = [renderPrompt(config.system, config.workdir)];
  const contract = read(process.env.AGENTIC_CONTRACT || "");
  if (contract) {
    parts.push(contract);
  }
  parts.push(
    `# 你自己的源码\n\nagentic 的应用源码（workspace）在 ${workspace}。改自己时到这里改；平时帮用户干活用上面的工作目录，不要在这里写用户的东西。`,
  );
  const agentDoc = read(path.join(workspace, "AGENT.md"));
  if (agentDoc) {
    parts.push(`# 当前的 AGENT.md\n\n${agentDoc}`);
  }
  const rollback = read(path.join(workspace, ".agentic", "rollback.json"));
  if (rollback) {
    parts.push(
      `# 注意：应用被 launcher 回滚过\n\n${rollback}\n先告诉用户发生了什么。处理完后删掉 .agentic/rollback.json。`,
    );
  }
  const news = read(path.join(workspace, ".agentic", "news.json"));
  if (news) {
    parts.push(
      `# 官方发布了新东西，用户还没决定要不要\n\n${news}\n按契约「新东西」一节处理：合适的时候简短告诉用户，问要不要加；不要每轮都提。`,
    );
  }
  return parts.join("\n\n---\n\n");
}
