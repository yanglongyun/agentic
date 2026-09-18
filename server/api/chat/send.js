import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { run } from "../../agent/index.js";
import { message } from "../../ai/index.js";
import { requireModel, renderPrompt } from "../../config.js";
import { fail } from "../http.js";

export default async function send(request, peer, context) {
  const id = request.session_id;
  const requestId = request.request_id;
  const db = context.db;
  const active = context.activeReplies;
  const { text, images = [] } = request;
  if (!Array.isArray(images) || images.length > 5) {
    fail(400, "每条消息最多发送 5 张图片");
  }
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text) > 128 * 1024 ||
    (!text.trim() && images.length === 0)
  ) {
    fail(400, "请输入文字或选择图片，文字最多 128 KiB");
  }
  for (const image of images) {
    if (
      typeof image !== "string" ||
      !db.prepare("SELECT url FROM session_images WHERE session_id = ? AND url = ?").get(id, image)
    ) {
      fail(400, "图片不属于当前会话，请重新上传");
    }
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({ text, images })).digest("hex");
  const previous = db.prepare("SELECT * FROM chat_requests WHERE id = ?").get(requestId);
  if (previous) {
    if (previous.session_id !== id || previous.fingerprint !== fingerprint) {
      fail(409, "请求 ID 已用于其他内容");
    }
    peer.send({ type: "request.accepted", request_id: requestId, session_id: id, duplicate: true });
    return;
  }
  try {
    requireModel(context.config);
  } catch (error) {
    fail(400, error.message);
  }
  const session = db
    .prepare(
      `
    SELECT sessions.*, (
      SELECT item FROM messages WHERE session_id = sessions.id ORDER BY id LIMIT 1
    ) AS first FROM sessions WHERE id = ?
  `,
    )
    .get(id);
  if (!session) {
    fail(404, "会话不存在");
  }
  if (active.has(id)) {
    fail(409, "会话正在回复");
  }
  const config = {
    ...context.config,
    session_id: id,
    images_dir: context.paths.images,
    run_images: new Set(),
  };
  const controller = new AbortController();
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const state = {
    id: requestId,
    controller,
    done,
    live: [],
    error: "",
    status: "running",
    stopReason: "",
  };
  active.set(id, state);
  const timer = setTimeout(
    () => controller.abort(new DOMException("回复超时", "TimeoutError")),
    config.run_timeout * 1000,
  );
  let accepted = false;
  function emit(outgoing) {
    const { saved, session, compaction, sequence: itemSequence, created_at, ...event } = outgoing;
    if (event.type === "done") {
      state.status = event.status;
      state.stopReason = event.stopReason || "";
    }
    if (event.type === "error") {
      state.error = event.error;
    }
    if (accepted) {
      context.chat.publish(id, {
        type: "run.event",
        run_id: requestId,
        event,
        sequence: itemSequence,
        created_at,
      });
      if (saved) {
        const messages = saved.map((entry) => ({
          ...entry,
          item: JSON.parse(db.prepare("SELECT item FROM messages WHERE id = ?").get(entry.id).item),
        }));
        context.chat.publish(id, { type: "messages.saved", run_id: requestId, messages });
      }
      if (compaction) {
        context.chat.publish(id, { type: "compaction.created", compaction });
      }
      if (session) {
        context.chat.publish(id, {
          type: "session.updated",
          session: { ...session, running: true },
        });
      }
    }
  }
  let errorSent = false;
  let doneSent = false;
  const first = session.first ? JSON.parse(session.first) : message(text);
  const preview =
    first.content
      .map((part) => part.text || "")
      .join("")
      .replace(/\s+/g, " ")
      .slice(0, 60) || "[图片]";
  let sequence = 0;
  try {
    // 先保存本次用户输入，下面查询上下文时会一起取出，不再重复追加。
    const user = {
      session_id: id,
      item: message(text),
      usage: null,
      created_at: Date.now(),
    };
    if (!text.trim()) {
      user.item.content = [];
    }
    for (const imageURL of images) {
      user.item.content.push({ type: "input_image", image_url: imageURL, detail: "auto" });
    }
    controller.signal.throwIfAborted();
    db.exec("BEGIN IMMEDIATE");
    try {
      const saved = db
        .prepare("INSERT INTO messages (session_id, item, created_at) VALUES (?, ?, ?)")
        .run(id, JSON.stringify(user.item), user.created_at);
      user.id = Number(saved.lastInsertRowid);
      db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(user.created_at, id);
      db.prepare(
        "INSERT INTO chat_requests (id, session_id, fingerprint, result, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)",
      ).run(requestId, id, fingerprint, user.created_at, user.created_at);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    accepted = true;
    peer.send({
      type: "request.accepted",
      request_id: requestId,
      session_id: id,
      duplicate: false,
    });
    context.chat.publish(id, { type: "run.started", run_id: requestId });
    // 用户消息已提交，即使随后停止或模型失败，也要保留其图片。
    config.run_images.clear();

    // 找到最近一条模型输出，即使它没有 usage，也不回退到更早的用量。
    const previousResponse = db
      .prepare(
        `
      SELECT usage FROM messages
      WHERE session_id = ? AND (
        json_extract(item, '$.role') = 'assistant'
        OR json_extract(item, '$.type') IN ('function_call', 'reasoning')
      )
      ORDER BY id DESC LIMIT 1
    `,
      )
      .get(id);
    const usage = previousResponse?.usage ? JSON.parse(previousResponse.usage) : null;
    // 最新摘要的 through_id 表示已覆盖到哪条消息（包含该条）。
    const latest = db
      .prepare("SELECT * FROM compactions WHERE session_id = ? ORDER BY id DESC LIMIT 1")
      .get(id);
    // 无摘要就取全会话；有摘要就取覆盖位置之后的全部消息，按 ID 排到最新。
    const stored = db
      .prepare("SELECT id, item FROM messages WHERE session_id = ? AND id > ? ORDER BY id")
      .all(id, latest?.through_id || 0);
    const messages = stored.map((row) => JSON.parse(row.item));
    // 与 messages 位置一一对应，供压缩时把数组下标映射回数据库 ID。
    const messageIds = stored.map((row) => row.id);
    if (latest) {
      // 上下文 = 最新摘要 + 后续消息（已包含本次用户输入）。
      messages.unshift(message(latest.summary));
      messageIds.unshift(latest.through_id);
    }

    const pending = [];
    let remainingCalls = 0;
    let receivedUsage = false;
    emit({
      type: "message",
      item: user.item,
      sequence: sequence++,
      created_at: user.created_at,
      saved: [{ sequence: 0, id: user.id, usage: null, created_at: user.created_at }],
      session: {
        id,
        title: session.title,
        preview,
        running: true,
        created_at: session.created_at,
        updated_at: user.created_at,
      },
    });
    // 业务层准备完整指令，Agent 只负责透传。
    const instructions = renderPrompt(config.system, config.workdir);
    // 业务层组装上下文，Agent 负责循环；事件回调负责保存并转发。
    await run({
      instructions,
      messages,
      model: config.model,
      config,
      usage,
      signal: controller.signal,
      onEvent: (event) => {
        switch (event.type) {
          case "error":
            errorSent = true;
            emit(event);
            return;
          case "done":
            doneSent = true;
            emit({
              ...event,
              session: {
                ...db.prepare("SELECT * FROM sessions WHERE id = ?").get(id),
                preview,
                running: false,
              },
            });
            return;
        }
        controller.signal.throwIfAborted();
        // API 的保存信息放在事件外层，Agent 的原始 item 保持不变。
        const outgoing = { ...event };
        switch (event.type) {
          case "compact": {
            if (event.status !== "completed") {
              break;
            }
            const throughId = messageIds[event.end - 1];
            if (event.start !== 0 || !throughId) {
              throw new Error("压缩边界无效");
            }
            const summary = event.item.content[0].text;
            outgoing.compaction = db
              .prepare(
                "INSERT INTO compactions (session_id, through_id, summary, created_at) VALUES (?, ?, ?, ?) RETURNING *",
              )
              .get(id, throughId, summary, Date.now());
            messageIds.splice(event.start, event.end - event.start, throughId);
            break;
          }
          case "message":
          case "reasoning":
          case "function_call":
          case "function_call_output": {
            if (!event.item) {
              break;
            }
            outgoing.sequence = sequence++;
            outgoing.created_at = Date.now();
            pending.push({
              sequence: outgoing.sequence,
              item: event.item,
              usage: null,
              created_at: outgoing.created_at,
            });
            if (event.type === "function_call") {
              remainingCalls++;
            } else if (event.type === "function_call_output") {
              remainingCalls--;
            }
            break;
          }
          case "usage":
            receivedUsage = true;
            if (pending.length > 0) {
              pending[pending.length - 1].usage = event.usage;
            }
            break;
        }

        // usage 只表示模型响应完成，工具结果齐全后才提交这一轮。
        if (receivedUsage && remainingCalls === 0 && pending.length > 0) {
          const savedMessages = [];
          let savedSession;
          db.exec("BEGIN IMMEDIATE");
          try {
            for (const row of pending) {
              let savedUsage = null;
              if (row.usage !== null) {
                savedUsage = JSON.stringify(row.usage);
              }
              const saved = db
                .prepare(
                  "INSERT INTO messages (session_id, item, usage, created_at) VALUES (?, ?, ?, ?)",
                )
                .run(id, JSON.stringify(row.item), savedUsage, row.created_at);
              savedMessages.push({
                sequence: row.sequence,
                id: Number(saved.lastInsertRowid),
                usage: row.usage,
                created_at: row.created_at,
              });
            }
            savedSession = db
              .prepare("UPDATE sessions SET updated_at = ? WHERE id = ? RETURNING *")
              .get(pending.at(-1).created_at, id);
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          // COMMIT 成功后才通知前端接管真实 ID；失败不能确认任何一条。
          outgoing.saved = savedMessages;
          outgoing.session = { ...savedSession, preview, running: true };
          messageIds.push(...savedMessages.map((row) => row.id));
          // 本轮图片已被完整消息引用，之后不再属于待清理文件。
          for (const row of pending) {
            if (row.item.type === "function_call_output" && Array.isArray(row.item.output)) {
              for (const part of row.item.output) {
                if (part.type === "input_image") {
                  config.run_images.delete(part.image_url);
                }
              }
            }
          }
          pending.length = 0;
          receivedUsage = false;
        }
        emit(outgoing);
      },
    });
  } catch (error) {
    if (!accepted) {
      throw error;
    }
    if (!doneSent) {
      let status = "incomplete";
      let stopReason = error.code || "api_error";
      if (controller.signal.aborted && controller.signal.reason?.name !== "TimeoutError") {
        status = "aborted";
        stopReason = "aborted";
      } else if (!errorSent) {
        emit({ type: "error", code: stopReason, error: error.message });
      }
      emit({
        type: "done",
        status,
        stopReason,
        session: {
          ...db.prepare("SELECT * FROM sessions WHERE id = ?").get(id),
          preview,
          running: false,
        },
      });
    }
  } finally {
    clearTimeout(timer);
    for (const imageURL of config.run_images) {
      try {
        await fs.rm(path.join(context.paths.images, path.basename(imageURL)), { force: true });
      } catch (error) {
        console.error("清理未保存图片失败：", error.message);
      }
    }
    active.delete(id);
    try {
      if (accepted) {
        const result = { status: state.status, stopReason: state.stopReason, error: state.error };
        db.prepare("UPDATE chat_requests SET result = ?, updated_at = ? WHERE id = ?").run(
          JSON.stringify(result),
          Date.now(),
          requestId,
        );
        context.chat.publish(id, { type: "run.finished", run_id: requestId, ...result });
        context.chat.publish(id, {
          type: "session.updated",
          session: {
            ...db.prepare("SELECT * FROM sessions WHERE id = ?").get(id),
            preview,
            running: false,
          },
        });
      }
    } finally {
      finish();
    }
  }
}
