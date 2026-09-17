import { create } from "zustand";
import { api } from "../lib/api";
import { remoteRoot } from "../lib/remote";
import { toast } from "../overlay/toast";
import { startSocket, stopSocket, selectSession, requestSocket, type Packet } from "./socket";
import type { AgentEvent } from "./events";
import {
  mergeMessages,
  itemText,
  type RawMessage,
  type Row,
  type Compaction,
  type StoredItem,
  type MessageItem,
} from "./thread";

export interface Thread {
  id: string;
  title: string;
  preview: string;
  running: boolean;
  created_at: number;
  updated_at: number;
}
export interface Status {
  version?: string;
  model: string;
  url?: string;
  model_ready: boolean;
  workdir: string;
  data_dir?: string;
}
interface Page {
  messages: RawMessage[];
  has_more: boolean;
}
interface Run {
  id: string;
  status: string;
  live: RawMessage[];
  error?: string;
  stopReason?: string;
}
interface Snapshot extends Page {
  session: Thread;
  compactions: Compaction[];
  run: Run | null;
  status: Status;
}
interface ThreadState {
  threads: Thread[];
  currentId: string;
  status: Status | null;
  messages: RawMessage[];
  compactions: Compaction[];
  notes: Row[];
  expanded: Record<string, boolean>;
  busy: boolean;
  stopping: boolean;
  ready: boolean;
  online: boolean;
  loadError: string;
  viewSeq: number;
  generation: number;
  hasMore: boolean;
  loadingOlder: boolean;
  runId: string;
  submitting: boolean;
}
export const threadTitle = (thread: Thread | undefined) =>
  thread?.title || thread?.preview || "对话";
export const useThread = create<ThreadState>(() => ({
  threads: [],
  currentId: "",
  status: null,
  messages: [],
  compactions: [],
  notes: [],
  expanded: {},
  busy: false,
  stopping: false,
  ready: false,
  online: false,
  loadError: "",
  viewSeq: 0,
  generation: 0,
  hasMore: false,
  loadingOlder: false,
  runId: "",
  submitting: false,
}));
const set = useThread.setState;
const get = useThread.getState;
const url = (id: string) => `/api/sessions/${encodeURIComponent(id)}`;
function updateThread(session: Thread) {
  set((state) => ({
    threads: [
      { ...state.threads.find((entry) => entry.id === session.id), ...session },
      ...state.threads.filter((entry) => entry.id !== session.id),
    ].sort((a, b) => b.updated_at - a.updated_at),
  }));
}
function notesFor(run: { status?: string; error?: string; stopReason?: string } | null): Row[] {
  if (run?.error || run?.status === "incomplete") {
    return [
      {
        key: crypto.randomUUID(),
        kind: "system",
        code: "error",
        content: run.error || run.stopReason || "回复未完成",
      },
    ];
  }
  if (run?.status === "aborted") {
    return [{ key: crypto.randomUUID(), kind: "system", code: "stopped" }];
  }
  return [];
}
export function receivePacket(packet: Packet) {
  if (packet.type === "remote.error") {
    set({ loadError: String(packet.error), ready: false });
    return;
  }
  if (packet.type === "connected" && remoteRoot && packet.session_id) {
    set({ currentId: packet.session_id });
  }
  if (packet.type === "session.updated") {
    updateThread(packet.session as Thread);
  }
  if (packet.type === "session.deleted") {
    set((state) => ({
      threads: state.threads.filter((thread) => thread.id !== packet.session_id),
    }));
    if (get().currentId === packet.session_id) {
      set({ loadError: "会话已删除", busy: false, ready: false });
    }
  }
  if (packet.session_id !== get().currentId) {
    return;
  }
  if (packet.type === "subscribed") {
    const snapshot = packet.snapshot as Snapshot;
    updateThread(snapshot.session);
    set((state) => ({
      messages: [
        ...snapshot.messages,
        ...(snapshot.run?.live || []),
        ...state.messages.filter((entry) => state.submitting && entry.sending),
      ],
      compactions: snapshot.compactions,
      hasMore: snapshot.has_more,
      status: snapshot.status,
      busy: state.submitting || snapshot.run?.status === "running",
      runId: snapshot.run?.id || "",
      ready: true,
      loadError: "",
      notes: notesFor(snapshot.run),
      viewSeq: state.viewSeq + 1,
    }));
  } else if (packet.type === "request.rejected" && !get().ready) {
    set({ loadError: String(packet.error) });
  } else if (packet.type === "run.started") {
    set({ runId: packet.run_id as string, busy: true, submitting: false, notes: [] });
    if (get().stopping) {
      void stopRun();
    }
  } else if (packet.type === "run.event") {
    receiveAgent(
      packet.event as AgentEvent,
      packet.sequence as number | undefined,
      packet.created_at as number | undefined,
    );
  } else if (packet.type === "messages.saved") {
    const saved = packet.messages as RawMessage[];
    set((state) => {
      const messages = [...state.messages];
      for (const row of saved) {
        const index = messages.findIndex(
          (entry) =>
            entry.id === row.id ||
            (entry.id === 0 && entry.sequence !== undefined && entry.sequence === row.sequence),
        );
        const value = { ...row, sequence: undefined, sending: false, streaming: false };
        if (index >= 0) {
          messages[index] = { ...messages[index], ...value };
        } else {
          messages.push(value);
        }
      }
      return { messages };
    });
  } else if (packet.type === "compaction.created") {
    const compaction = packet.compaction as Compaction;
    set((state) => ({
      compactions: [...state.compactions.filter((entry) => entry.id !== compaction.id), compaction],
    }));
  } else if (packet.type === "run.finished") {
    set((state) => ({
      messages: state.messages.filter((entry) => entry.id > 0),
      notes: notesFor(packet as { status?: string; error?: string; stopReason?: string }),
      busy: false,
      stopping: false,
    }));
  }
}
function receiveAgent(event: AgentEvent, sequence?: number, created_at?: number) {
  if (
    ["message", "reasoning", "function_call", "function_call_output"].includes(event.type) &&
    "item" in event &&
    event.item
  ) {
    const item = event.item;
    set((state) => {
      const index = state.messages.findIndex(
        (entry) =>
          (entry.streaming && entry.item.type === item.type) ||
          (entry.sending && item.type === "message" && item.role === "user"),
      );
      const row = {
        id: 0,
        key: crypto.randomUUID(),
        item,
        sequence,
        created_at,
        sending: false,
        streaming: false,
      };
      if (index < 0) {
        return { messages: [...state.messages, row] };
      }
      return {
        messages: state.messages.map((entry, position) =>
          position === index ? { ...row, key: entry.key } : entry,
        ),
      };
    });
  } else if ((event.type === "message" || event.type === "reasoning") && "delta" in event) {
    set((state) => {
      const index = state.messages.findIndex(
        (entry) => entry.streaming && entry.item.type === event.type,
      );
      let text = event.delta || "";
      if (index >= 0) {
        const item = state.messages[index].item;
        if (item.type === "message" || item.type === "reasoning") {
          text = itemText(item) + text;
        }
      }
      let item: StoredItem;
      if (event.type === "message") {
        item = { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
      } else {
        item = { type: "reasoning", summary: [{ type: "summary_text", text }] };
      }
      if (index >= 0) {
        return {
          messages: state.messages.map((entry, position) =>
            position === index ? { ...entry, item } : entry,
          ),
        };
      }
      return {
        messages: [
          ...state.messages,
          { id: 0, key: crypto.randomUUID(), item, streaming: true, created_at: Date.now() },
        ],
      };
    });
  } else if (event.type === "compact" && event.status === "started") {
    toast("正在压缩上下文…");
  } else if (event.type === "retry") {
    toast(`请求失败，${event.delayMs / 1000} 秒后重试（${event.attempt}/${event.maxRetries}）`);
  }
}
export function dispose() {
  stopSocket();
  set((state) => ({
    generation: state.generation + 1,
    online: false,
    ready: false,
    busy: false,
    stopping: false,
  }));
}
function reset() {
  set((state) => ({
    generation: state.generation + 1,
    messages: [],
    compactions: [],
    notes: [],
    expanded: {},
    busy: false,
    stopping: false,
    ready: false,
    loadError: "",
    hasMore: false,
    loadingOlder: false,
    runId: "",
    submitting: false,
  }));
}
export async function loadStatus() {
  try {
    set({ status: await api.get<Status>("/api/status") });
    return true;
  } catch (error) {
    toast(error instanceof Error ? error.message : "服务状态加载失败");
    return false;
  }
}
export async function loadThreads() {
  try {
    const data = await api.get<{ sessions: Thread[] }>("/api/sessions");
    set({ threads: data.sessions });
    return true;
  } catch (error) {
    toast(error instanceof Error ? error.message : "会话列表加载失败");
    return false;
  }
}
export async function init() {
  startSocket(receivePacket, (online) => set({ online }));
  if (!remoteRoot) {
    await Promise.all([loadStatus(), loadThreads()]);
  }
}
export async function openThread(id: string, force = false) {
  if (!id || (!force && get().currentId === id && (get().ready || get().busy))) {
    return;
  }
  reset();
  set({ currentId: id });
  selectSession(id);
}
export function createDraft() {
  reset();
  selectSession("");
  set((state) => ({ currentId: "", ready: true, viewSeq: state.viewSeq + 1 }));
}
export async function loadOlder() {
  const { currentId, hasMore, loadingOlder, busy, generation, messages } = get();
  if (!currentId || !hasMore || loadingOlder || busy) {
    return;
  }
  set({ loadingOlder: true });
  try {
    const page = await api.get<Page>(
      `${url(currentId)}/messages?limit=60&before=${messages[0].id}`,
    );
    if (get().generation === generation) {
      set((state) => ({
        messages: mergeMessages(page.messages, state.messages),
        hasMore: page.has_more,
      }));
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : "历史消息加载失败");
  } finally {
    if (get().generation === generation) {
      set({ loadingOlder: false });
    }
  }
}
export function send(
  text: string,
  retryRow: Row | null = null,
  onCreated?: (id: string) => void,
  images: string[] = [],
): boolean {
  const content = text.trim();
  if ((!content && images.length === 0) || get().busy || !get().ready) {
    return false;
  }
  if (!get().online) {
    toast("连接尚未恢复，请稍后发送");
    return false;
  }
  if (images.length > 5) {
    toast("每条消息最多发送 5 张图片");
    return false;
  }
  if (!get().status?.model_ready) {
    toast("请先在本地设置中配置模型");
    return false;
  }
  const key = retryRow?.key || crypto.randomUUID();
  const item: MessageItem = { type: "message", role: "user", content: [] };
  if (content) {
    item.content.push({ type: "input_text", text: content });
  }
  for (const image of images) {
    item.content.push({ type: "input_image", image_url: image, detail: "auto" });
  }
  const user: RawMessage = { id: 0, key, item, created_at: Date.now(), sending: true };
  set((state) => ({
    messages: [...state.messages.filter((entry) => entry.key !== key), user],
    notes: [],
    busy: true,
    submitting: true,
    runId: "",
    viewSeq: state.viewSeq + 1,
  }));
  void submit(content, images, user, get().generation, onCreated);
  return true;
}
async function submit(
  text: string,
  images: string[],
  user: RawMessage,
  generation: number,
  onCreated?: (id: string) => void,
) {
  let id = get().currentId;
  try {
    if (!id) {
      const session = await api.post<Thread>("/api/sessions");
      if (get().generation !== generation) {
        return;
      }
      id = session.id;
      set({ currentId: id });
      updateThread(session);
      selectSession(id);
      onCreated?.(id);
    }
    const uploaded: string[] = [];
    for (const image of images) {
      if (image.startsWith("/api/images/")) {
        uploaded.push(image);
      } else {
        const result = await api.post<{ url: string }>(`${url(id)}/images`, { image });
        uploaded.push(result.url);
      }
    }
    if (get().generation !== generation) {
      return;
    }
    // 请求 ID 在重连后保持不变；服务端通过数据库去重，防止断线重发执行两次。
    const accepted = await requestSocket({
      type: "send",
      request_id: crypto.randomUUID(),
      session_id: id,
      text,
      images: uploaded,
    });
    if (get().generation === generation) {
      set({ submitting: false });
    }
    if (accepted.duplicate && get().currentId === id) {
      selectSession(id);
    }
    if (get().stopping && get().currentId === id) {
      void stopRun();
    }
  } catch (error) {
    if (get().generation !== generation) {
      return;
    }
    toast(error instanceof Error ? error.message : "发送失败");
    set((state) => ({
      messages: [
        ...state.messages.filter((entry) => entry.key !== user.key),
        { ...user, sending: false, failed: true },
      ],
      busy: false,
      submitting: false,
      stopping: false,
    }));
  }
}
export const retrySend = (row: Row, onCreated?: (id: string) => void) =>
  row.failed ? send(row.content || "", row, onCreated, row.images) : false;
export async function stopRun() {
  if (!get().busy) {
    return;
  }
  set({ stopping: true });
  if (!get().runId) {
    return;
  }
  try {
    await requestSocket({ type: "cancel", session_id: get().currentId, run_id: get().runId });
  } catch (error) {
    set({ stopping: false });
    toast(error instanceof Error ? error.message : "停止失败");
  }
}
export async function renameThread(id: string, title: string) {
  try {
    const session = await api.patch<Thread>(url(id), { title });
    updateThread(session);
  } catch (error) {
    toast(error instanceof Error ? error.message : "重命名失败");
  }
}
export async function removeThread(id: string) {
  try {
    await api.del(url(id));
    set((state) => ({ threads: state.threads.filter((thread) => thread.id !== id) }));
    if (get().currentId === id) {
      createDraft();
    }
    return true;
  } catch (error) {
    toast(error instanceof Error ? error.message : "删除失败");
    return false;
  }
}
