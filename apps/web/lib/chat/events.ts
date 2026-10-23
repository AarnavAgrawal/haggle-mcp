// How a streamed chat event changes the conversation on screen (pure; used by components/chat/Chat.tsx).
// Type-only imports, so the browser bundle pulls in nothing from the server side.
import type { ChatEvent } from "./agent";
import type { DisplayItem } from "./history";

/** Applies one streamed event to the conversation (pure). */
export function applyEvent(items: DisplayItem[], e: ChatEvent): DisplayItem[] {
  const last = items[items.length - 1];
  switch (e.type) {
    case "text":
      if (last?.kind === "assistant") return [...items.slice(0, -1), { ...last, text: last.text + e.delta }];
      return [...items, { kind: "assistant", text: e.delta }];
    case "tool": {
      if (e.status !== "start") {
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i]!;
          if (it.kind === "tool" && it.name === e.name && it.status === "start") {
            return [...items.slice(0, i), { ...it, status: e.status, summary: e.summary }, ...items.slice(i + 1)];
          }
        }
      }
      return [...items, { kind: "tool", name: e.name, status: e.status, summary: e.summary }];
    }
    case "deal":
      return items.some((it) => it.kind === "deal" && it.job_id === e.job_id) ? items : [...items, { kind: "deal", job_id: e.job_id }];
    case "error":
      return [...items, { kind: "error", text: e.message }];
    default:
      return items;
  }
}
