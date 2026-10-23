// Pure chat logic: thread titles and ownership, the history window, what the browser shows, the
// streamed-event reducer and the per-user turn limit. No database, no network.
import { describe, expect, it } from "vitest";
import { CONTEXT_PREFIX, userTurn } from "../lib/chat/agent.ts";
import { applyEvent } from "../lib/chat/events.ts";
import { historyWindow, titleFrom, toDisplay } from "../lib/chat/history.ts";
import { turnLimiter } from "../lib/chat/limits.ts";
import { isThreadId, ownsThread } from "../lib/chat/store.ts";

describe("chat store logic", () => {
  it("titles a thread from the first message: one line, at most 80 characters", () => {
    expect(titleFrom("  Cater lunch\nfor 40  ")).toBe("Cater lunch for 40");
    const long = titleFrom("x".repeat(200));
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith("…")).toBe(true);
    expect(titleFrom("   ")).toBe("New request");
  });

  it("a thread is yours only as the same user in the same workspace", () => {
    const row = { user_id: "u1", workspace_id: "ws_a" };
    expect(ownsThread(row, { userId: "u1", workspaceId: "ws_a" })).toBe(true);
    expect(ownsThread(row, { userId: "u2", workspaceId: "ws_a" })).toBe(false);
    expect(ownsThread(row, { userId: "u1", workspaceId: "ws_b" })).toBe(false);
    expect(ownsThread(null, { userId: "u1", workspaceId: "ws_a" })).toBe(false);
    expect(isThreadId("6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f")).toBe(true);
    expect(isThreadId("../etc")).toBe(false);
  });

  it("the history window starts at a typed user turn, never at an orphaned tool result", () => {
    const msgs = [
      { role: "user" as const, content: [{ type: "text" as const, text: "first" }] },
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "t1", name: "list_deals", input: {} }] },
      { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "t1", content: "ok" }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "done" }] },
      { role: "user" as const, content: [{ type: "text" as const, text: "second" }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] },
    ];
    expect(historyWindow(msgs, 10)).toBe(msgs);
    expect(historyWindow(msgs, 4).map((m) => m.role)).toEqual(["user", "assistant"]);
    expect((historyWindow(msgs, 4)[0]!.content as { text: string }[])[0]!.text).toBe("second");
  });

  it("shows only typed text, assistant text, tool chips and the deal card (never the context block)", () => {
    const items = toDisplay(
      [
        userTurn("Lunch for 40", new Date("2026-10-22T00:00:00Z")),
        { role: "assistant", content: [{ type: "thinking", thinking: "secret plan", signature: "s" }, { type: "text", text: "Checking." }, { type: "tool_use", id: "t1", name: "deal", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "DRY RUN" }] },
        { role: "assistant", content: [{ type: "text", text: "Go ahead?" }] },
      ],
      "job_9",
    );
    expect(items).toEqual([
      { kind: "user", text: "Lunch for 40" },
      { kind: "assistant", text: "Checking." },
      { kind: "tool", name: "deal", status: "done", summary: "deal" },
      { kind: "assistant", text: "Go ahead?" },
      { kind: "deal", job_id: "job_9" },
    ]);
    expect(JSON.stringify(items)).not.toContain(CONTEXT_PREFIX.trim());
    expect(JSON.stringify(items)).not.toContain("secret plan");
  });

  it("streamed events build the conversation: text appends, chips update in place, one deal card", () => {
    let xs = applyEvent([], { type: "text", delta: "Hel" });
    xs = applyEvent(xs, { type: "text", delta: "lo" });
    xs = applyEvent(xs, { type: "tool", name: "deal", status: "start", summary: "Starting deal" });
    xs = applyEvent(xs, { type: "tool", name: "deal", status: "done", summary: "Deal job_1 started" });
    xs = applyEvent(xs, { type: "deal", job_id: "job_1" });
    xs = applyEvent(xs, { type: "deal", job_id: "job_1" });
    xs = applyEvent(xs, { type: "text", delta: "Next" });
    expect(xs).toEqual([
      { kind: "assistant", text: "Hello" },
      { kind: "tool", name: "deal", status: "done", summary: "Deal job_1 started" },
      { kind: "deal", job_id: "job_1" },
      { kind: "assistant", text: "Next" },
    ]);
  });

  it("allows 20 turns per user per 10 minutes", () => {
    const take = turnLimiter(20, 600_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) expect(take("u1", t0 + i).ok).toBe(true);
    const refused = take("u1", t0 + 100);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.retryAfterS).toBeGreaterThan(0);
    expect(take("u2", t0 + 100).ok).toBe(true);
    expect(take("u1", t0 + 600_001).ok).toBe(true);
  });
});
