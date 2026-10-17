// POST /webhooks/inkbox for the non-email channels (src/webhook.ts): signed imessage.received
// approves, a2a.sent_task.updated turns the seller's task result into a quote, and an abridged
// call.ended transcript is replaced by the full one before parsing. Real engine in live
// configuration with fake Inkbox ports (no network, no real call, iMessage or task).
import { describe, expect, it } from "vitest";
import {
  disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, inkboxEmail, type A2APort, type A2ATaskView, type IMessagePort, type PhonePort, type QuoteExtraction,
} from "@haggle/engine";
import { BUYER, FakeInkbox, SECRET, signed } from "../../../packages/engine/tests/helpers/fakeInkbox.ts";
import { handleInkboxWebhook } from "../src/webhook.ts";
import type { Runtime } from "../src/runtime.ts";

const CARD = "https://inkbox.ai/a2a/bay-catering-sf/card";
const APPROVER = "+14155550123";
const event = (id: string, type: string, data: Record<string, unknown>) => JSON.stringify({ id, event_type: type, timestamp: new Date().toISOString(), data });

function liveRuntime() {
  const api = new FakeInkbox();
  const repo = new InMemoryRepository();
  const tasks = new Map<string, A2ATaskView>();
  const a2a: A2APort & { sent: unknown[] } = {
    sent: [],
    async send(r) { a2a.sent.push(r); const id = `task-${a2a.sent.length}`; tasks.set(id, { taskId: id, contextId: r.contextId ?? "ctx-1", state: "working", agentMessages: [] }); return { taskId: id, contextId: r.contextId ?? "ctx-1", state: "submitted" }; },
    async getTask(r) { return tasks.get(r.taskId)!; },
  };
  const imsgs: { to: string; text: string }[] = [];
  const imessage: IMessagePort = { async send(r) { imsgs.push(r); return { messageId: `im_${imsgs.length}` }; } };
  const calls: string[] = [];
  const phone: PhonePort = { async placeCall(r) { calls.push(r.toNumber); return { callId: "call_1" }; } };
  const extract = async (i: { bodyText: string }): Promise<QuoteExtraction> => ({
    available: true, price_per_head_usd: null, headcount: 40, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true,
    total_usd: /\$1,070/.test(i.bodyText) ? 1070 : null, deposit_usd: 50, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 14 }], valid_until: null, questions: [],
    payment_request: "none", instructions_to_agent: false, sources: [{ field: "total", source: "call transcript", excerpt: "$1,070" }], missing_fields: /\$1,070/.test(i.bodyText) ? [] : ["total"], confidence: 0.9,
  });
  const engine = new HaggleEngine({
    repo, email: inkboxEmail(api, BUYER), a2a, imessage, phone, extractor: { extract }, attachments: { load: async (m) => m.attachments.filter((x) => x.content_base64).map((x) => ({ kind: "json" as const, filename: x.filename ?? "quote.json", data: Buffer.from(x.content_base64!, "base64") })) },
    brain: new StubBrain(), payer: disabledPayer("Payments are not enabled yet"),
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: BUYER, collectionWindowMs: 600_000, negotiationWindowMs: 300_000, approvalTtlMs: 1_800_000, globalPaymentCapCents: 500, maxRounds: 2 },
  });
  const transcriptCalls: string[] = [];
  const rt: Runtime = { mode: "live", engine, missing: [], inkbox: { api, buyerMailbox: BUYER, webhookSecret: SECRET, senderTrust: { policy: "outbound-verified" }, transcript: async (id) => { transcriptCalls.push(id); return "haggle (AI assistant): I'm an AI assistant calling for a quote.\nremote: For 40 people it's $1,070 total, 14 vegetarian, $50 deposit."; } } };
  return { rt, engine, repo, a2a, tasks, imsgs, calls, transcriptCalls };
}

describe("POST /webhooks/inkbox: A2A, iMessage, calls", () => {
  it("a2a.sent_task.updated: the seller's completed task becomes a quote (channel a2a)", async () => {
    const { rt, engine, tasks, a2a } = liveRuntime();
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Bay Catering", a2a_card_url: CARD }] });
    expect(a2a.sent).toHaveLength(1);
    tasks.set("task-1", { taskId: "task-1", contextId: "ctx-1", state: "completed", agentMessages: [{ messageId: "m1", text: "Our quote: $995 total.", data: [{ protocol: "haggle.quote.v1", type: "quote", total_usd: 995, deposit_usd: 199, vegetarian_meals: 12, delivery_included: true }] }] });
    const raw = event("evt_a1", "a2a.sent_task.updated", { task_id: "task-1", context_id: "ctx-1", state: "completed", caller: { identity_id: "x", organization_id: "o", handle: "haggle" } });
    expect(await handleInkboxWebhook(rt, raw, signed(raw))).toMatchObject({ status: 200, jobId: deal.job_id, outcome: "stored" });
    const board = await engine.getQuotes(deal.job_id);
    expect(board.quotes[0]).toMatchObject({ business: "Bay Catering", channel: "a2a", source: "a2a task", total_usd: 995, deposit_usd: 199, verdict: "compliant" });
    const again = await handleInkboxWebhook(rt, raw, signed(raw));
    expect(again.outcome).toBe("a2a:completed"); // redelivery stores nothing new
  });

  it("imessage.received: YES <code> from the settings approver approves; a forged sender doesn't", async () => {
    const { rt, engine, tasks, imsgs, repo } = liveRuntime();
    await engine.updateSettings({ approver_phone: APPROVER });
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Bay Catering", a2a_card_url: CARD }] });
    tasks.set("task-1", { taskId: "task-1", contextId: "ctx-1", state: "completed", agentMessages: [{ messageId: "m1", text: "$995", data: [{ protocol: "haggle.quote.v1", type: "quote", total_usd: 995, deposit_usd: 5, vegetarian_meals: 12, delivery_included: true }] }] });
    await engine.ingestA2aTask("task-1");
    const q = (await engine.getQuotes(deal.job_id)).quotes[0]!;
    const a = await engine.requestApproval(deal.job_id, q.quote_id, "imessage");
    expect(imsgs[0]).toMatchObject({ to: APPROVER, text: expect.stringContaining(`YES ${a.code}`) });
    const forged = event("evt_i0", "imessage.received", { message: { id: "im_in_0", direction: "inbound", sender_number: "+14155550000", content: `YES ${a.code}`, is_group: false, conversation_id: "c" } });
    expect((await handleInkboxWebhook(rt, forged, signed(forged))).outcome).toBe("not_approver");
    const raw = event("evt_i1", "imessage.received", { message: { id: "im_in_1", direction: "inbound", sender_number: APPROVER, content: `YES ${a.code}`, is_group: false, conversation_id: "c" } });
    expect(await handleInkboxWebhook(rt, raw, signed(raw))).toMatchObject({ status: 200, jobId: deal.job_id, outcome: "approved" });
    expect(await repo.getApproval(a.id)).toMatchObject({ status: "approved", channel: "imessage" });
    const unsigned = await handleInkboxWebhook(rt, raw, new Headers());
    expect(unsigned.status).toBe(401);
  });

  it("call.ended with an abridged transcript: the full transcript is fetched before parsing", async () => {
    const { rt, engine, calls, transcriptCalls } = liveRuntime();
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Mission Eats", phone: "+14155550104" }] });
    expect(calls).toEqual(["+14155550104"]);
    const raw = event("evt_c1", "call.ended", { call: { id: "call_1", direction: "outbound", remote_phone_number: "+14155550104" }, outcome: "completed", transcript: { entries: [{ party: "local", text: "Hi, I'm an AI assistant" }, { marker: "abridged" }], abridged: true } });
    expect(await handleInkboxWebhook(rt, raw, signed(raw))).toMatchObject({ status: 200, outcome: "stored" });
    expect(transcriptCalls).toEqual(["call_1"]);
    await engine.advanceJob(deal.job_id);
    const board = await engine.getQuotes(deal.job_id);
    expect(board.quotes[0]).toMatchObject({ business: "Mission Eats", channel: "phone", total_usd: 1070 });
    expect(board.businesses[0]!.transcript_snippet).toMatch(/AI assistant/);
  });
});

describe("brain start-up never crashes the server", () => {
  it("HAGGLE_BRAIN_STORE=memory wins over Supabase keys, and a failing start-up is only logged", { timeout: 20_000 }, async () => {
    const { brainStoreEnv, makeBrain } = await import("../src/brain.ts");
    expect(brainStoreEnv({ HAGGLE_BRAIN_STORE: "memory", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" })).toEqual({ HAGGLE_BRAIN_STORE: "memory" });
    const errors: string[] = [];
    const orig = console.error;
    console.error = (m: string) => { errors.push(String(m)); };
    try {
      // An unresolvable Supabase host: start-up fails; the process must survive (no unhandled rejection).
      makeBrain([], { SUPABASE_URL: "https://does-not-exist.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
      for (let i = 0; i < 100 && !errors.some((e) => e.includes("brain_start_failed")); i++) await new Promise((r) => setTimeout(r, 100));
    } finally {
      console.error = orig;
    }
    expect(errors.some((e) => e.includes("brain_start_failed"))).toBe(true);
  });
});
