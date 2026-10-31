// The chat's deal cards (lib/chat/cards.ts): built only from the tool input and whitelisted data,
// the same live (agent.ts card event) and from a stored thread (history.ts toDisplay).
import { describe, expect, it } from "vitest";
import { runTool } from "../lib/chat/agent.ts";
import { applyEvent } from "../lib/chat/events.ts";
import { toDisplay } from "../lib/chat/history.ts";
import { briefFromInput, formatDay, formatTime, storedToolCard, toolCard } from "../lib/chat/cards.ts";

const input = {
  request: {
    what: "lunch catering", quantity: 40, unit: "people", date: "2026-11-05", time: "12:00", area: "San Francisco, CA",
    requirements: [{ id: "veg12", kind: "dietary", text: "At least 12 vegetarian meals", hard: true, min_count: 12 }, "delivery included"],
    details: [{ label: "service", value: "drop-off" }],
  },
  budget_usd: 1200,
  dry_run: true,
};

describe("chat cards", () => {
  it("formats days and times as written, with no time zone shift", () => {
    expect(formatDay("2026-11-05")).toBe("Thu, Nov 5");
    expect(formatDay("next Saturday")).toBe("next Saturday");
    expect(formatTime("12:00")).toBe("12 pm");
    expect(formatTime("08:30")).toBe("8:30 am");
    expect(formatTime("noon")).toBe("noon");
  });

  it("reads the brief from deal's input: what, how many, when, where, budget, must-haves", () => {
    expect(briefFromInput(input)).toEqual({
      what: "Lunch catering", quantity: "40 people", when: "Thu, Nov 5, 12 pm", where: "San Francisco, CA", budget_usd: 1200,
      details: [{ label: "Service", value: "drop-off" }],
      must_haves: ["At least 12 vegetarian meals", "Delivery included"],
    });
    expect(briefFromInput({})).toBeNull();
    expect(briefFromInput({ request: { what: "plumber", where: "Mission", dietary: ["nut-free", "Nut-free"] }, budget: "under $300" })).toMatchObject({ where: "Mission", budget_text: "under $300", must_haves: ["Nut-free"] });
  });

  it("a dry run becomes the preview: who would be contacted and who can't be", () => {
    const card = toolCard("deal", input, { mode: "mock", dry_run: true, would_contact: [{ name: "Harbor Table", channel: "email", email: "x@y.z" }, { name: "Golden Grill", channel: "phone" }], blocked: [{ name: "Bay BBQ", reason: "no consent" }] });
    expect(card).toMatchObject({ kind: "preview", demo: true, contact: [{ name: "Harbor Table", channel: "email" }, { name: "Golden Grill", channel: "phone" }], blocked: [{ name: "Bay BBQ", reason: "no consent" }] });
    // Contact details never reach the card.
    expect(JSON.stringify(card)).not.toContain("x@y.z");
  });

  it("needs_info becomes a checklist of what's missing", () => {
    expect(toolCard("deal", { request: { what: "plumber" } }, { mode: "live", needs_info: { label: "Home repair", missing: [{ question: "What's wrong?" }], helpful: [{ question: "How old is it?" }] } })).toEqual({
      kind: "needs_info", demo: false, label: "Home repair", missing: ["What's wrong?"], optional: ["How old is it?"],
    });
  });

  it("a started deal is named by its request, never by its id", () => {
    const card = toolCard("deal", { ...input, dry_run: undefined }, { mode: "mock", job_id: "job_77", request_details: { what: "lunch catering", headcount: 40, when: "Thu Nov 5, 12:00", place: "San Francisco, CA", budget_usd: 1200 }, contacted: [{ business: "Harbor Table", channel: "email" }], not_contacted: [] }, "job_77");
    expect(card).toEqual({ kind: "started", demo: true, job_id: "job_77", title: "Lunch catering for 40", when: "Thu Nov 5, 12:00", where: "San Francisco, CA", budget_usd: 1200, contacted: [{ name: "Harbor Table", channel: "email" }], not_contacted: 0 });
    expect(toolCard("get_quotes", {}, {})).toBeUndefined();
    expect(toolCard("deal", {}, { ok: false })).toBeUndefined();
  });

  it("a stored deal call is shown as its card, even when the stored data was capped", () => {
    const capped = { content: `Deal job_5 started: lunch for 40.\n\ndata: {"job_id":"job_5","businesses":[…truncated` };
    expect(storedToolCard("deal", { request: { what: "lunch", quantity: 40 } }, capped)).toMatchObject({ kind: "started", job_id: "job_5", title: "Lunch for 40" });
    expect(storedToolCard("deal", input, { content: "boom", is_error: true })).toBeUndefined();

    const items = toDisplay([
      { role: "user", content: "Lunch for 40" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "deal", input }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: `DRY RUN\n\ndata: ${JSON.stringify({ mode: "mock", dry_run: true, would_contact: [{ name: "Harbor Table", channel: "email" }], blocked: [] })}` }] },
      { role: "assistant", content: [{ type: "text", text: "Go ahead?" }] },
    ]);
    expect(items.map((x) => x.kind)).toEqual(["user", "tool", "card", "assistant"]);
  });

  it("the live stream sends a deal call's card after its chip, and never for other tools", async () => {
    const events: unknown[] = [];
    const haggle = {
      listTools: async () => [],
      callTool: async (name: string) => (name === "deal" ? { text: "DRY RUN", data: { mode: "mock", dry_run: true, would_contact: [{ name: "Harbor Table", channel: "email" }], blocked: [] }, meta: { code: "SECRET" } } : { text: "ok", data: {} }),
    } as unknown as Parameters<typeof runTool>[0];
    await runTool(haggle, { id: "t1", name: "deal", input }, (e) => events.push(e));
    await runTool(haggle, { id: "t2", name: "get_quotes", input: { job_id: "job_1" } }, (e) => events.push(e));
    expect(events.map((e) => (e as { type: string }).type)).toEqual(["tool", "tool", "card", "tool", "tool"]);
    expect(events[2]).toMatchObject({ type: "card", card: { kind: "preview", contact: [{ name: "Harbor Table", channel: "email" }] } });
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it("a card event adds the card to the conversation", () => {
    const xs = applyEvent([], { type: "card", card: { kind: "needs_info", demo: false, label: "Catering", missing: ["How many people?"], optional: [] } });
    expect(xs).toEqual([{ kind: "card", card: { kind: "needs_info", demo: false, label: "Catering", missing: ["How many people?"], optional: [] } }]);
  });
});
