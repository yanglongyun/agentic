import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../index.js";
import { defaults, paths } from "../config.js";
import { message } from "../ai/index.js";
import modelServer from "./model.js";

import WebSocket from "ws";
export async function fixture(t, respond, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-test-"));
  const p = paths({ AGENT_HOME: root });
  const config = {
    ...defaults(),
    key: "test-model-key",
    workdir: root,
    ...overrides,
    api: { listen: "127.0.0.1:0", token: "test-access-token-123456" },
  };
  config.url = await modelServer(t, (request, emit, signal) =>
    respond(config, request.input, request.tools, request.instructions, emit, signal),
  );
  const runtime = createServer({ p, config });
  const origin = await runtime.listen();
  t.after(async () => {
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const headers = {
    authorization: `Bearer ${config.api.token}`,
    "content-type": "application/json",
  };
  const request = (route, method = "GET", data, extra = {}) =>
    fetch(origin + route, {
      method,
      headers,
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      ...extra,
    });
  const newSession = async () => {
    const r = await request("/api/sessions", "POST", {});
    assert.equal(r.status, 201);
    return (await r.json()).id;
  };
  const connect = () => chatClient(t, origin.replace("http", "ws") + "/api/chat", { headers });
  return { root, p, config, runtime, origin, headers, request, newSession, connect };
}

export async function chatClient(t, address, options = {}) {
  const socket = new WebSocket(address, options);
  const packets = [];
  const listeners = new Set();
  socket.on("message", (raw) => {
    const packet = JSON.parse(raw.toString());
    packets.push(packet);
    for (const listener of listeners) {
      listener(packet);
    }
  });
  socket.on("error", () => {});
  t.after(() => socket.terminate());
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  function wait(type, predicate = () => true, start = 0) {
    const found = packets.slice(start).find((packet) => packet.type === type && predicate(packet));
    if (found) {
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`等待 ${type} 超时: ${JSON.stringify(packets.slice(-3))}`));
      }, 10000);
      function listener(packet) {
        if (packet.type === type && predicate(packet)) {
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(packet);
        }
      }
      listeners.add(listener);
    });
  }
  function command(type, session_id, data = {}) {
    if (type === "cancel" && !data.run_id) {
      data = {
        ...data,
        run_id: packets.findLast(
          (packet) => packet.type === "run.started" && packet.session_id === session_id,
        )?.run_id,
      };
    }
    const request_id = data.request_id || crypto.randomUUID();
    socket.send(JSON.stringify({ type, session_id, request_id, ...data }));
    return request_id;
  }
  async function subscribe(id) {
    const requestId = command("subscribe", id);
    return (await wait("subscribed", (packet) => packet.request_id === requestId)).snapshot;
  }
  async function run(id, text, images = []) {
    await subscribe(id);
    const start = packets.length;
    const runId = command("send", id, { text, images });
    await wait("run.finished", (packet) => packet.run_id === runId, start);
    return packets.slice(start);
  }
  return { socket, packets, wait, command, subscribe, run };
}
