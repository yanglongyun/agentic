import { saveConfig, validateConfig } from "../../config.js";
import { body, json, fail } from "../http.js";

export default async function put(req, res, context) {
  const patch = await body(
    req,
    [
      "url",
      "key",
      "model",
      "context_window",
      "system",
      "compact_at",
      "keep",
      "compact_system",
      "compact_prefix",
      "workdir",
      "run_timeout",
      "timeout",
      "max_output",
      "api",
      "browser",
    ],
    512 * 1024,
  );
  const next = {
    ...context.config,
    browser: { ...context.config.browser },
    api: { ...context.config.api },
  };

  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case "url":
      case "key":
      case "model":
      case "workdir": {
        if (typeof value !== "string") {
          fail(400, `${key} 必须是字符串`);
        }
        // 设置页不回显密钥，留空表示保留已保存的密钥。
        if (key === "key" && value.trim() === "") {
          break;
        }
        next[key] = value.trim();
        break;
      }
      case "system":
      case "compact_system":
      case "compact_prefix":
      case "context_window":
      case "compact_at":
      case "keep":
      case "run_timeout":
      case "timeout":
      case "max_output": {
        next[key] = value;
        break;
      }
      case "browser": {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          fail(400, "browser 必须是对象");
        }
        for (const [field, setting] of Object.entries(value)) {
          if (!["mode", "jev_model", "jev_key"].includes(field) || typeof setting !== "string") {
            fail(400, `无效 browser 字段：${field}`);
          }
          if (field === "jev_key" && setting.trim() === "") {
            continue;
          }
          next.browser[field] = setting.trim();
        }
        break;
      }
      case "api": {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          fail(400, "api 必须是对象");
        }
        for (const field of Object.keys(value)) {
          if (field !== "listen") {
            fail(400, "api 只接受 listen");
          }
        }
        if (value.listen === undefined) {
          break;
        }
        next.api.listen = value.listen;
        break;
      }
    }
  }

  try {
    validateConfig(next);
  } catch (error) {
    fail(400, error.message);
  }

  const restartRequired = next.api.listen !== context.config.api.listen;
  saveConfig(context.paths, next);
  context.config = next;
  return json(res, 200, { restart_required: restartRequired });
}
