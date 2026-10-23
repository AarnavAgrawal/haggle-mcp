// Pure helpers over a thread's stored messages: the thread title, the window sent to the model, and
// what the browser shows (only the text of user and assistant turns, tool activity as chips).
import type Anthropic from "@anthropic-ai/sdk";
import { CONTEXT_PREFIX } from "./agent";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type Block = { type: string; text?: string; name?: string };

export const TITLE_MAX = 80;
export const HISTORY_MAX_MESSAGES = 80;

/** A thread title from the first user message: one line, at most 80 characters. */
export function titleFrom(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (!one) return "New request";
  return one.length > TITLE_MAX ? `${one.slice(0, TITLE_MAX - 1).trimEnd()}…` : one;
}

const blocks = (m: MessageParam): Block[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Block[]));

/** A user turn the person typed (not a turn of tool results only). */
const isTypedUserTurn = (m: MessageParam) => m.role === "user" && blocks(m).some((b) => b.type === "text");

/**
 * The most recent messages, starting at a typed user turn so no tool_result is cut from its
 * tool_use. A long thread keeps working; old turns simply drop out of the model's context.
 */
export function historyWindow(messages: MessageParam[], max = HISTORY_MAX_MESSAGES): MessageParam[] {
  if (messages.length <= max) return messages;
  for (let i = messages.length - max; i < messages.length; i++) {
    if (isTypedUserTurn(messages[i]!)) return messages.slice(i);
  }
  // One enormous turn: keep it whole from its own start.
  for (let i = messages.length - 1; i >= 0; i--) if (isTypedUserTurn(messages[i]!)) return messages.slice(i);
  return [];
}

export type DisplayItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; status: "start" | "done" | "error"; summary: string }
  | { kind: "deal"; job_id: string }
  | { kind: "error"; text: string };

/** What a stored thread looks like in the chat: typed text, assistant text, tool chips, the deal card. */
export function toDisplay(messages: MessageParam[], jobId?: string | null): DisplayItem[] {
  const out: DisplayItem[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = blocks(m).filter((b) => b.type === "text" && typeof b.text === "string" && !b.text.startsWith(CONTEXT_PREFIX)).map((b) => b.text).join("\n").trim();
      if (text) out.push({ kind: "user", text });
      continue;
    }
    if (m.role !== "assistant") continue;
    for (const b of blocks(m)) {
      if (b.type === "text" && b.text?.trim()) {
        const prev = out[out.length - 1];
        if (prev?.kind === "assistant") prev.text += `\n\n${b.text}`;
        else out.push({ kind: "assistant", text: b.text });
      } else if (b.type === "tool_use" && b.name) {
        out.push({ kind: "tool", name: b.name, status: "done", summary: b.name.replace(/_/g, " ") });
      }
    }
  }
  if (jobId) out.push({ kind: "deal", job_id: jobId });
  return out;
}
