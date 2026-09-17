import type { MessageItem, ReasoningItem, FunctionCallItem, FunctionOutputItem } from "./thread";
export type AgentEvent =
  | { type: "message"; delta: string; item?: never }
  | { type: "message"; item: MessageItem; delta?: never }
  | { type: "reasoning"; delta: string; item?: never }
  | { type: "reasoning"; item: ReasoningItem; delta?: never }
  | { type: "function_call"; item: FunctionCallItem }
  | { type: "function_call_output"; item: FunctionOutputItem }
  | { type: "retry"; attempt: number; maxRetries: number; delayMs: number; error: string }
  | { type: "usage"; usage: Record<string, unknown> | null }
  | { type: "compact"; status: "started" }
  | {
      type: "compact";
      status: "completed";
      item: MessageItem;
      start: number;
      end: number;
      usage: Record<string, unknown> | null;
    }
  | { type: "done"; status: "completed" | "incomplete" | "aborted"; stopReason?: string }
  | { type: "error"; code: string; error: string };
