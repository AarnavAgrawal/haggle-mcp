// The chat turn (lib/chat/agent.ts) against a fake Anthropic stream and a fake Haggle client: the
// allowlist (approve/pay never reach the server), `meta` never reaching the model, HaggleError fixes,
// the deal event (and none for a dry run), the step cap, refusal, pause_turn and the request shape.
import { describe, expect, it } from "vitest";
import { MAX_MODEL_CALLS, runChatTurn, type ChatEvent, type ChatModelClient } from "../lib/chat/agent.ts";
import { CHAT_SYSTEM_PROMPT } from "../lib/chat/prompt.ts";
import { HaggleError } from "../lib/haggle.ts";
import { LLM_TOOLS } from "../lib/tools.ts";

type Block = Record<string, unknown>;
type Scripted = { content: Block[]; stop_reason: string };

const toolUse = (name: string, input: Record<string, unknown> = {}, id = `tu_${name}_${Math.random().toString(36).slice(2, 8)}`): Block => ({ type: "tool_use", id, name, input });
const text = (t: string): Block => ({ type: "text", text: t });
const reply = (stop_reason: string, ...content: Block[]): Scripted => ({ content, stop_reason });

/** A fake client: each stream() call plays the next scripted message (or the fallback forever). */
function fakeAnthropic(script: Scripted[], fallback?: Scripted) {
  const requests: Record<string, unknown>[] = [];
  const client: ChatModelClient = {
    beta: {
      messages: {
        stream(body) {
          requests.push(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
          const msg = script.shift() ?? fallback;
          if (!msg) throw new Error("script exhausted");
          let onText: ((d: string, s: string) => void) | undefined;
          return {
            on(_event: "text", fn: (d: string, s: string) => void) {
              onText = fn;
              return this;
            },
            async finalMessage() {
              for (const b of msg.content) if (b.type === "text") onText?.(String(b.text), String(b.text));
              return { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: msg.content, stop_reason: msg.stop_reason, stop_sequence: null, usage: {} } as never;
            },
          };
        },
      },
    },
  };
  return { client, requests };
}

/** A fake Haggle server: every LLM tool plus the human-only ones are listed; handlers per tool. */
function fakeHaggle(handlers: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    client: {
      async listTools() {
        return [...LLM_TOOLS, "approve", "pay", "call_back"].map((name) => ({ name, description: `${name} tool`, inputSchema: { type: "object", properties: {} } }));
      },
      async callTool<T>(name: string, args: Record<string, unknown> = {}) {
        calls.push({ name, args });
        const h = handlers[name];
        const out = h ? h(args) : { data: { ok: true, mode: "mock" }, text: `${name} ok` };
        return out as { data: T; text: string; meta?: Record<string, unknown> };
      },
    },
  };
}

async function turn(script: Scripted[], handlers: Record<string, (args: Record<string, unknown>) => unknown> = {}, extra: { fallback?: Scripted; history?: never[] } = {}) {
  const ai = fakeAnthropic(script, extra.fallback);
  const hg = fakeHaggle(handlers);
  const events: ChatEvent[] = [];
  const result = await runChatTurn({ anthropic: ai.client, haggle: hg.client, history: extra.history ?? [], userText: "Cater lunch for 40", onEvent: (e) => events.push(e), today: new Date("2026-10-22T12:00:00Z") });
  return { ...ai, ...hg, events, result };
}

const toolResults = (all: readonly unknown[]) =>
  (all as { role: string; content: unknown }[]).flatMap((m) => (m.role === "user" && Array.isArray(m.content) ? (m.content as Block[]).filter((b) => b.type === "tool_result") : []));

describe("runChatTurn", () => {
  it("never runs approve or pay: the model gets an is_error result and the server is not called", async () => {
    const t = await turn([reply("tool_use", toolUse("pay", { job_id: "job_1", quote_id: "q1" }), toolUse("approve", { job_id: "job_1", quote_id: "q1" })), reply("end_turn", text("Please approve on the dashboard."))]);
    expect(t.calls.map((c) => c.name)).toEqual([]);
    const results = toolResults(t.result.messages);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.is_error).toBe(true);
      expect(String(r.content)).toMatch(/not available here/);
    }
    // Both results in ONE user message, right after the assistant turn.
    expect(t.result.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // The human-only tools are not even offered to the model.
    const offered = (t.requests[0]!.tools as { name: string }[]).map((x) => x.name);
    expect(offered).not.toContain("pay");
    expect(offered).not.toContain("approve");
    expect(offered).not.toContain("call_back");
  });

  it("never puts the tool's meta (approval codes) in a tool result or a later request", async () => {
    const t = await turn([reply("tool_use", toolUse("get_quotes", { job_id: "job_1" })), reply("end_turn", text("Here are the quotes."))], {
      get_quotes: () => ({ data: { ok: true, mode: "mock", quotes: [{ business: "Harbor Table", total_usd: 900 }] }, text: "1 quote", meta: { "haggle/approval": { code: "SECRET-8842" } } }),
    });
    const [r] = toolResults(t.result.messages);
    expect(String(r!.content)).toContain("Harbor Table");
    expect(JSON.stringify(t.result.messages)).not.toContain("SECRET-8842");
    expect(JSON.stringify(t.requests)).not.toContain("SECRET-8842");
    expect(JSON.stringify(t.events)).not.toContain("SECRET-8842");
  });

  it("caps a tool result's content", async () => {
    const t = await turn([reply("tool_use", toolUse("list_deals")), reply("end_turn", text("ok"))], {
      list_deals: () => ({ data: { deals: Array.from({ length: 2000 }, (_, i) => ({ job_id: `job_${i}` })) }, text: "many" }),
    });
    expect(String(toolResults(t.result.messages)[0]!.content).length).toBeLessThanOrEqual(6000);
  });

  it("a HaggleError comes back as is_error with the server's fix and next step", async () => {
    const t = await turn([reply("tool_use", toolUse("get_quotes", { job_id: "job_x" })), reply("end_turn", text("That deal wasn't found."))], {
      get_quotes: () => {
        throw new HaggleError("job_not_found", "No such deal.", "Call list_deals to find the job_id.", "list_deals");
      },
    });
    const [r] = toolResults(t.result.messages);
    expect(r!.is_error).toBe(true);
    expect(String(r!.content)).toContain("No such deal.");
    expect(String(r!.content)).toContain("Fix: Call list_deals to find the job_id.");
    expect(String(r!.content)).toContain("Next: list_deals");
    expect(t.events).toContainEqual({ type: "tool", name: "get_quotes", status: "error", summary: "No such deal." });
  });

  it("emits a deal event with the job id when deal really starts", async () => {
    const t = await turn([reply("tool_use", toolUse("deal", { request: { what: "lunch", quantity: 40, date: "2026-10-30" } })), reply("end_turn", text("Started. Progress is at /deals/job_77."))], {
      deal: () => ({ data: { ok: true, mode: "mock", job: { id: "job_77" }, job_id: "job_77" }, text: "Deal job_77 started" }),
    });
    expect(t.events).toContainEqual({ type: "deal", job_id: "job_77" });
    expect(t.result.jobId).toBe("job_77");
    expect(t.events.at(-1)).toEqual({ type: "done" });
  });

  it("emits no deal event for a dry run", async () => {
    const t = await turn([reply("tool_use", toolUse("deal", { request: { what: "lunch" }, dry_run: true })), reply("end_turn", text("Haggle would contact 3 businesses. Go ahead?"))], {
      deal: () => ({ data: { ok: true, mode: "mock", job: null, dry_run: true, would_contact: [{ name: "Harbor Table", channel: "email" }] }, text: "DRY RUN (nothing sent)" }),
    });
    expect(t.events.some((e) => e.type === "deal")).toBe(false);
    expect(t.result.jobId).toBeUndefined();
    expect(t.events).toContainEqual({ type: "tool", name: "deal", status: "done", summary: "Preview ready (nothing sent)" });
  });

  it("a deal that needs info starts nothing and says so", async () => {
    const t = await turn([reply("tool_use", toolUse("deal", { request: { what: "plumber" }, dry_run: true })), reply("end_turn", text("A few quick questions: what's wrong, where, and how urgent?"))], {
      deal: () => ({ data: { ok: false, mode: "mock", job: null, needs_info: { category: "home_repair", label: "Home repair", missing: [{ key: "problem", question: "What's wrong?", field: "details: Problem" }], helpful: [], brief: "plumber" } }, text: "NEEDS INFO (nothing sent)" }),
    });
    expect(t.events.some((e) => e.type === "deal")).toBe(false);
    expect(t.result.jobId).toBeUndefined();
    expect(t.events).toContainEqual({ type: "tool", name: "deal", status: "done", summary: "Needs a few details (nothing sent)" });
  });

  it("the system prompt does intake per kind of purchase: one message, restate the brief, handle needs_info", () => {
    expect(CHAT_SYSTEM_PROMPT).toMatch(/In ONE short, friendly message/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/restate the brief in one line/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/Home repair and trades.*what's wrong and where in the home/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/Moving: from where to where/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/If deal returns needs_info, nothing was sent/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/proceed_anyway: true only if the user explicitly says/);
    expect(CHAT_SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/); // still a byte-stable cache prefix
  });

  it("caps wait_for_update at 20 seconds", async () => {
    const t = await turn([reply("tool_use", toolUse("wait_for_update", { job_id: "job_1", timeout_s: 60 }), toolUse("wait_for_update", { job_id: "job_1" })), reply("end_turn", text("No news yet."))]);
    expect(t.calls.map((c) => c.args.timeout_s)).toEqual([20, 20]);
  });

  it("stops after 12 model calls and leaves the stored history valid", async () => {
    const t = await turn([], {}, { fallback: reply("tool_use", toolUse("list_deals", {}, "tu_loop")) });
    expect(t.requests).toHaveLength(MAX_MODEL_CALLS);
    expect(t.events.some((e) => e.type === "error" && /Stopped after 12 steps/.test(e.message))).toBe(true);
    const last = t.result.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect((last.content as unknown as Block[])[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_loop", is_error: true });
    // Tools ran only for the calls that were followed by another model call.
    expect(t.calls).toHaveLength(MAX_MODEL_CALLS - 1);
  });

  it("a refusal ends the turn with an error event and the refused reply isn't kept", async () => {
    const t = await turn([reply("refusal", text("I can't help with that."))]);
    expect(t.events.some((e) => e.type === "error" && /declined/.test(e.message))).toBe(true);
    expect(t.result.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("continues after pause_turn without adding a user message", async () => {
    const t = await turn([reply("pause_turn", text("Working…")), reply("end_turn", text("Done."))]);
    expect(t.requests).toHaveLength(2);
    expect(t.result.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
  });

  it("sends the documented request shape with cache breakpoints and today's date in the user turn", async () => {
    const t = await turn([reply("end_turn", text("What's the headcount?"))]);
    const req = t.requests[0]!;
    expect(req).toMatchObject({ model: "claude-opus-5-5", max_tokens: 16000, thinking: { type: "adaptive" }, output_config: { effort: "medium" }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    expect(req.tool_choice).toBeUndefined();
    const tools = req.tools as { name: string; input_schema: unknown; cache_control?: unknown }[];
    expect(tools.at(-1)!.cache_control).toEqual({ type: "ephemeral" });
    expect(tools.slice(0, -1).every((x) => x.cache_control === undefined)).toBe(true);
    expect(tools[0]!.input_schema).toMatchObject({ type: "object" });
    expect((req.system as Block[])[0]).toMatchObject({ type: "text", cache_control: { type: "ephemeral" } });
    expect(String((req.system as Block[])[0]!.text)).not.toMatch(/2026/);
    const user = (req.messages as { content: Block[] }[])[0]!;
    expect(user.content[0]).toEqual({ type: "text", text: "Cater lunch for 40" });
    expect(String(user.content[1]!.text)).toContain("2026-10-22");
    expect(t.events.filter((e) => e.type === "text")).toEqual([{ type: "text", delta: "What's the headcount?" }]);
  });

  it("an API failure becomes an error event and the user's message is still returned", async () => {
    const ai: ChatModelClient = { beta: { messages: { stream() { throw Object.assign(new Error("overloaded"), { status: 529 }); } } } };
    const events: ChatEvent[] = [];
    const r = await runChatTurn({ anthropic: ai, haggle: fakeHaggle().client, history: [], userText: "hi", onEvent: (e) => events.push(e) });
    expect(events).toEqual([{ type: "error", message: "Claude is busy right now. Try again in a minute." }]);
    expect(r.messages).toHaveLength(1);
  });
});
