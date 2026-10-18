// v5 Inkbox channels beyond email: A2A buyer->seller tasks, Voice AI call plumbing (origin, retries,
// full transcripts, inbound callers) and iMessage approval. Real engine + simulated fleet (mock) and
// fake Inkbox clients for the live adapters; no network, no real call, iMessage or task.
import { InkboxAPIError } from "@inkbox/sdk";
import { describe, expect, it } from "vitest";
import {
  a2aTaskView, createMockEngine, disabledPayer, fleetBusinesses, InMemoryRepository, StubBrain, fullCallTranscript, GOLDEN_REQUEST, HaggleEngine, inkboxA2A, inkboxCallEnded, inkboxIMessage, inkboxIMessageReceived, inkboxPhone,
  quotePartToExtraction, type IMessagePort,
} from "../src/index.ts";

const noSleep = async () => {};

function setup(extra: Parameters<typeof createMockEngine>[0] = {}) {
  let t = Date.now();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  return { ...createMockEngine({ now: clock.now, ...extra }), clock };
}
const businesses = (withCard: boolean) => fleetBusinesses().map((b) => ({ name: b.name, ...(b.email ? { email: b.email } : {}), ...(b.phone ? { phone: b.phone } : {}), ...(withCard && b.a2a_card_url ? { a2a_card_url: b.a2a_card_url } : {}), simulated: true }));
async function run(engine: HaggleEngine, clock: { advance(ms: number): void }, jobId: string, done: (q: Awaited<ReturnType<HaggleEngine["getQuotes"]>>) => boolean) {
  let cursor = 0;
  for (let i = 0; i < 200; i++) {
    clock.advance(1_000);
    cursor = Number((await engine.waitForUpdate(jobId, cursor, 0)).cursor);
    const q = await engine.getQuotes(jobId);
    for (const pq of q.pending_questions) await engine.answerSeller(jobId, pq.question_id, "Yes, plates for 40.");
    if (done(q)) return q;
  }
  throw new Error("did not converge");
}

describe("A2A buyer -> seller tasks (simulated fleet, real engine)", () => {
  it("RFQ task to the pinned card → seller-shape quote parsed → counter in the same context → Bay wins", async () => {
    const learned: { channel?: string; reply_channel?: string }[] = [];
    const { engine, clock, fleet, repo } = setup();
    const spy = engine as unknown as { d: { brain: { learnFromReply: (...a: unknown[]) => Promise<unknown> } } };
    const real = spy.d.brain.learnFromReply.bind(spy.d.brain);
    spy.d.brain.learnFromReply = async (id, parsed, meta) => { learned.push(meta as never); return real(id, parsed, meta); };
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await engine.deal({ request, budget_usd, businesses: businesses(true) });
    expect(deal.contacted.find((c) => c.business === "Bay Catering")).toMatchObject({ channel: "a2a" });
    const rfq = fleet.a2aSent[0]!;
    expect(rfq).toMatchObject({ cardUrl: "https://a2a.sim.haggle.dev/bay-catering/card", data: expect.objectContaining({ type: "rfq", protocol: "haggle.v0", quantity: 40, vegetarian: 12, job_id: deal.job_id }) });
    expect(rfq.text).toMatch(/lunch catering/);
    expect(fleet.sent.some((s) => s.to === "quotes@bay-catering.sim.haggle.dev")).toBe(false); // A2A instead of email

    const ready = await run(engine, clock, deal.job_id, (q) => q.ready);
    const bay = ready.quotes.find((q) => q.business === "Bay Catering")!;
    expect(bay).toMatchObject({ channel: "a2a", source: "a2a task", total_usd: 995, negotiated_from: 1150, verdict: "compliant", deposit_usd: 5 });
    expect(ready.recommended_quote_id).toBe(bay.quote_id);
    // The counter went over A2A, in the SAME context, as a new task citing a real competing quote.
    const counter = fleet.a2aSent.find((s) => s.data.type === "counter")!;
    expect(counter.contextId).toBeTruthy();
    expect(counter.data).toMatchObject({ basis: "competing_quote" });
    const bayRow = (await repo.getBusinesses(deal.job_id)).find((b) => b.name === "Bay Catering")!;
    expect(counter.contextId).toBe(bayRow.thread_id);
    const msgs = (await repo.listMessages(deal.job_id)).filter((m) => m.channel === "a2a");
    expect(msgs.filter((m) => m.direction === "in").every((m) => m.sender_trusted && m.trust_reason === "a2a-task-to-pinned-card")).toBe(true);
    expect(learned.some((m) => m.reply_channel === "a2a" && m.channel === "a2a")).toBe(true);
    expect(ready.businesses.find((b) => b.name === "Bay Catering")).toMatchObject({ channel: "a2a", status: "quoted" });
  });

  it("re-delivered task results are deduped; without A2A the card falls back to email", async () => {
    const { engine, clock } = setup();
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await engine.deal({ request, budget_usd, businesses: businesses(true).filter((b) => b.name === "Bay Catering") });
    await run(engine, clock, deal.job_id, (q) => q.quotes.length > 0);
    const taskId = (await (engine as unknown as { d: { repo: { listMessages(j: string): Promise<{ direction: string; provider_email_id: string | null }[]> } } }).d.repo.listMessages(deal.job_id)).find((m) => m.direction === "out")!.provider_email_id!.slice("a2a-task:".length);
    expect((await engine.ingestA2aTask(taskId)).outcome).toBe("a2a:completed"); // nothing new stored
    expect((await engine.ingestA2aTask("task-nobody-sent")).outcome).toBe("unknown_task");

    const off = setup({ a2a: false });
    const d2 = await off.engine.deal({ request, budget_usd, businesses: businesses(true).filter((b) => b.name === "Bay Catering") });
    expect(d2.contacted[0]).toMatchObject({ channel: "email" });
  });

  it("an Agent Card that isn't on the allowlist is never contacted", async () => {
    const { engine, fleet } = setup({ config: { recipientAllowlist: ["quotes@bay-catering.sim.haggle.dev"] } });
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    await expect(engine.deal({ request, budget_usd, businesses: businesses(true).filter((b) => b.name === "Bay Catering") })).rejects.toMatchObject({ code: "recipient_not_allowed" });
    expect(fleet.a2aSent).toHaveLength(0);
  });
});

describe("quote.json shapes (v3, CONTRACTS.md haggle.v0, Aarnav's haggle.quote.v1)", () => {
  const reqs = [{ id: "veg12", kind: "dietary" as const, need: "vegetarian", min_count: 12, hard: true, text: "At least 12 vegetarian meals" }, { id: "delivery", kind: "delivery" as const, hard: true, text: "Delivery included" }] as never;
  it("reads the seller shape and re-checks claims against the stated vegetarian count", () => {
    const golden = quotePartToExtraction({ protocol: "haggle.quote.v1", type: "quote", business: "Golden Grill", total_usd: 860, vegetarian_meals: 6, delivery_included: true, items: ["mains"], meets: { veg12: true } }, "job_1", reqs, 40);
    expect(golden.ok && golden.extraction.dietary_coverage).toEqual([{ need: "vegetarian", covered: false, count_offered: 6 }]); // the claim "veg12: true" is overruled
    const bay = quotePartToExtraction({ protocol: "haggle.quote.v1", type: "quote", total_usd: 995, per_unit_usd: 24.88, deposit_usd: 199, vegetarian_meals: 12, delivery_included: true, valid_until: "2026-10-24" }, "job_1", reqs, 40);
    expect(bay).toMatchObject({ ok: true, extraction: { total_usd: 995, deposit_usd: 199, price_per_head_usd: 24.88, delivery_included: true, valid_until: "2026-10-24" } });
  });
  it("reads the contract shape (items with tags, meets) and rejects another job's quote or a malformed v5 quote", () => {
    const v0 = quotePartToExtraction({ protocol: "haggle.v0", type: "quote", job_id: "job_1", total_usd: 1120, deposit_usd: 336, items: [{ description: "veg risotto", quantity: 14, tags: ["vegetarian"] }, { description: "salmon", quantity: 26 }], meets: { delivery: true } }, "job_1", reqs, 40);
    expect(v0.ok && v0.extraction.dietary_coverage).toEqual([{ need: "vegetarian", covered: true, count_offered: 14 }]);
    expect(v0.ok && v0.extraction.menu_items).toEqual(["14 veg risotto", "26 salmon"]);
    expect(quotePartToExtraction({ protocol: "haggle.v0", type: "quote", job_id: "job_2", total_usd: 1 }, "job_1", reqs, 40)).toMatchObject({ ok: false, reason: "quote.json is for another job" });
    expect(quotePartToExtraction({ protocol: "haggle.v0", type: "quote", total_usd: "lots" }, "job_1", reqs, 40)).toMatchObject({ ok: false, reason: "quote.json (v5) is malformed" });
  });
});

describe("live Inkbox channel adapters (fake clients)", () => {
  it("a2aTaskView: agent messages from history + final status message, roles in either form, deduped", () => {
    const v = a2aTaskView({ id: "t1", contextId: "c1", status: { state: "TASK_STATE_COMPLETED", message: { messageId: "m3", role: "ROLE_AGENT", parts: [{ text: "Total $995" }, { data: { type: "quote", total_usd: 995 } }] } },
      history: [{ messageId: "m1", role: "ROLE_USER", parts: [{ text: "RFQ" }] }, { messageId: "m2", role: "agent", parts: [{ text: "working on it" }] }, { messageId: "m3", role: "ROLE_AGENT", parts: [{ text: "Total $995" }] }] } as never);
    expect(v).toEqual({ taskId: "t1", contextId: "c1", state: "completed", agentMessages: [{ messageId: "m2", text: "working on it", data: [] }, { messageId: "m3", text: "Total $995", data: [] }] });
  });

  it("inkboxA2A sends text + data parts with a stable messageId, retries 5xx, resolves each card once", async () => {
    const sent: unknown[] = [];
    let fetches = 0;
    let fail = 1;
    const client = {
      fetchCard: async (url: string) => { fetches++; return { cardUrl: url, rpcUrl: "https://inkbox.ai/a2a/x/rpc", protocolVersion: "1.0", card: {} }; },
      send: async (_t: unknown, o: unknown) => { if (fail-- > 0) throw new InkboxAPIError(503, "hosted"); sent.push(o); return { kind: "task", task: { id: "task-1", contextId: "ctx-1", status: { state: "TASK_STATE_SUBMITTED" } } }; },
      getTask: async (_t: unknown, id: string, o: { historyLength?: number }) => ({ id, contextId: "ctx-1", status: { state: "TASK_STATE_WORKING" }, history: [], _h: o.historyLength }),
    };
    const port = inkboxA2A({ a2aClient: async () => client as never }, noSleep);
    const r = await port.send({ cardUrl: "https://inkbox.ai/a2a/bay-catering-sf/card", text: "RFQ text", data: { type: "rfq" }, messageId: "haggle-rfq-job_1-biz_1" });
    expect(r).toEqual({ taskId: "task-1", contextId: "ctx-1", state: "submitted" });
    expect(sent).toEqual([{ parts: [{ text: "RFQ text" }, { data: { type: "rfq" } }], messageId: "haggle-rfq-job_1-biz_1" }]);
    expect((await port.getTask({ cardUrl: "https://inkbox.ai/a2a/bay-catering-sf/card", taskId: "task-1" })).state).toBe("working");
    expect(fetches).toBe(1);
    await expect(port.send({ cardUrl: "http://insecure.example/card", text: "x", data: {}, messageId: "m" })).rejects.toThrow(/https/);
  });

  it("calls: shared iMessage origination, 503 hosted_agent_at_capacity retried, full transcript in order", async () => {
    let attempts = 0;
    const placed: { origination?: string; reason?: string }[] = [];
    const phone = inkboxPhone({ placeCall: async (o) => { attempts++; if (attempts === 1) throw new InkboxAPIError(503, "hosted_agent_at_capacity"); placed.push(o as never); return { id: "call_1" }; } }, "shared_imessage_number", noSleep);
    expect(await phone.placeCall({ jobId: "j", businessId: "b", toNumber: "+14155550104", reason: "I'm an AI assistant requesting a quote", idempotencyKey: "k" })).toEqual({ callId: "call_1" });
    expect(attempts).toBe(2);
    expect(placed[0]).toMatchObject({ origination: "shared_imessage_number", reason: expect.stringMatching(/AI assistant/) });
    const t = await fullCallTranscript({ listTranscripts: async () => [{ seq: 2, party: "remote", text: "$1,070 total" }, { seq: 1, party: "local", text: "Hi, I'm an AI assistant" }] }, "call_1");
    expect(t).toBe("haggle (AI assistant): Hi, I'm an AI assistant\nremote: $1,070 total");
    expect(inkboxCallEnded({ data: { call: { id: "c", direction: "inbound", remote_phone_number: "+14155550104" }, outcome: "completed", transcript: { entries: [{ party: "remote", text: "hi" }], abridged: true } } }))
      .toMatchObject({ callId: "c", abridged: true, direction: "inbound", remoteNumber: "+14155550104" });
  });

  it("iMessage adapters: send with idempotency key; webhook mapping", async () => {
    const calls: unknown[] = [];
    const port = inkboxIMessage({ sendIMessage: async (o) => { calls.push(o); return { id: "im_1" }; } }, noSleep);
    expect(await port.send({ to: "+14155550123", text: "Haggle: approve?", idempotencyKey: "imsg:approval:ap_1" })).toEqual({ messageId: "im_1" });
    expect(calls).toEqual([{ to: "+14155550123", text: "Haggle: approve?", idempotencyKey: "imsg:approval:ap_1" }]);
    expect(inkboxIMessageReceived({ data: { message: { id: "im_2", direction: "inbound", sender_number: "+1 (415) 555-0123", content: "YES 4821", is_group: false, conversation_id: "conv" } } }))
      .toEqual({ messageId: "im_2", from: "+14155550123", text: "YES 4821", isGroup: false, conversationId: "conv", inbound: true });
  });
});

describe("iMessage approval (real engine, fake iMessage port)", () => {
  const APPROVER = "+14155550123";
  async function approvable(imessage?: IMessagePort) {
    const s = setup({ ...(imessage ? { imessage } : {}) });
    await s.engine.updateSettings({ approver_phone: APPROVER });
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await s.engine.deal({ request, budget_usd, businesses: businesses(false) });
    const ready = await run(s.engine, s.clock, deal.job_id, (q) => q.ready);
    return { ...s, deal, bay: ready.quotes.find((q) => q.business === "Bay Catering")! };
  }

  it("the request text obeys Inkbox's pre-reply rules (≤ 159 chars, no links, no phone numbers)", () => {
    const t = HaggleEngine.approvalIMessageText("Bay Catering call +1 415 555 0199 www.bay.example https://pay.me/x", 99_500, 500, "4821");
    expect(t.length).toBeLessThanOrEqual(159);
    expect(t).not.toMatch(/https?:|www\.|\+?\d[\d\s().-]{6,}\d/);
    expect(t).toBe("Haggle: approve $5.00 deposit to Bay Catering call (quote $995.00)? Reply YES 4821 or NO 4821");
  });

  it("YES <code> from the approver approves that exact approval; everyone/everything else is ignored", async () => {
    const sent: { to: string; text: string }[] = [];
    const { engine, deal, bay, repo } = await approvable({ send: async (r) => { sent.push(r); return { messageId: `im_${sent.length}` }; } });
    const a = await engine.requestApproval(deal.job_id, bay.quote_id, "imessage");
    expect(sent).toEqual([{ to: APPROVER, text: expect.stringContaining(`YES ${a.code}`), idempotencyKey: expect.stringMatching(/^imsg:/) }]);
    expect(await engine.approvalIMessageSent(a.id)).toBe(true);
    const msg = (text: string, over: Partial<{ from: string; isGroup: boolean; messageId: string }> = {}) => ({ messageId: over.messageId ?? `in_${Math.random()}`, from: over.from ?? APPROVER, text, isGroup: over.isGroup ?? false, inbound: true });
    expect((await engine.ingestIMessage(msg(`YES ${a.code}`, { from: "+14155559999" }))).outcome).toBe("not_approver");
    expect((await engine.ingestIMessage(msg(`YES ${a.code}`, { isGroup: true }))).outcome).toBe("group_ignored");
    expect((await engine.ingestIMessage(msg("YES"))).outcome).toBe("code_required");
    // A wrong code against the approver's only pending approval counts toward the lockout.
    expect((await engine.ingestIMessage(msg("YES 0000"))).outcome).toBe(a.code === "0000" ? "approved" : "wrong_code");
    expect((await engine.ingestIMessage(msg("sure, sounds good!"))).outcome).toBe("not_a_decision");
    expect((await repo.getApproval(a.id))!).toMatchObject({ status: "pending", attempts: a.code === "0000" ? 0 : 1 });
    expect((await engine.ingestIMessage(msg(`yes ${a.code}`, { messageId: "in_ok" }))).outcome).toBe("approved");
    expect((await engine.ingestIMessage(msg(`yes ${a.code}`, { messageId: "in_ok" }))).outcome).toBe("duplicate");
    // Approved outside the chat: the approval is recorded; paying is the separate pay step (decision 2).
    expect(await repo.getApproval(a.id)).toMatchObject({ status: "approved", channel: "imessage", approver: APPROVER });
    expect((await repo.getJob(deal.job_id))!.state).toBe("paying");
  });

  it("NO <code> declines; a failed send leaves the approval card as the fallback", async () => {
    const declined = await approvable({ send: async () => ({ messageId: "im_x" }) });
    const a = await declined.engine.requestApproval(declined.deal.job_id, declined.bay.quote_id, "imessage");
    expect((await declined.engine.ingestIMessage({ messageId: "n1", from: APPROVER, text: `No ${a.code}`, isGroup: false })).outcome).toBe("declined");

    const broken = await approvable({ send: async () => { throw new InkboxAPIError(403, "recipient has not connected"); } });
    const b = await broken.engine.requestApproval(broken.deal.job_id, broken.bay.quote_id, "imessage");
    expect(await broken.engine.approvalIMessageSent(b.id)).toBe(false);
    expect((await broken.engine.approveWithViewCode(b.id, b.code)).status).toBe("approved"); // approved on the card; pay is the next step
    expect((await broken.repo.getJob(broken.deal.job_id))!.state).toBe("paying");
  });

  it("refuses an iMessage approval without an approver phone or with iMessage off", async () => {
    const s = setup();
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await s.engine.deal({ request, budget_usd, businesses: businesses(false) });
    const ready = await run(s.engine, s.clock, deal.job_id, (q) => q.ready);
    await expect(s.engine.requestApproval(deal.job_id, ready.recommended_quote_id!, "imessage")).rejects.toMatchObject({ code: "no_imessage_approver" });
  });
});

describe("calls a business places to Haggle", () => {
  it("are matched by caller number but never become quotes unless the operator trusts caller ID", async () => {
    for (const trust of [false, true]) {
      const { engine, clock, repo } = setup({ config: { trustInboundCallerId: trust } });
      const { budget_usd, ...request } = GOLDEN_REQUEST;
      const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Inbound Eats", email: "hi@inbound.example", phone: "+14155550177" }] });
      expect((await engine.ingestCall({ callId: `in-${trust}`, outcome: "completed", transcript: "We can do $1,000 total.", direction: "inbound", remoteNumber: "+14155550100" })).outcome).toBe("unknown_caller");
      const r = await engine.ingestCall({ callId: `in2-${trust}`, outcome: "completed", transcript: "remote: Inbound Eats here, $1,000 total including delivery.", direction: "inbound", remoteNumber: "+1 415 555 0177" });
      expect(r.outcome).toBe(trust ? "stored" : "stored_unverified");
      clock.advance(1_000);
      const board = await engine.getQuotes(deal.job_id);
      if (!trust) expect(board.quotes).toHaveLength(0);
      const inbound = (await repo.listMessages(deal.job_id)).find((m) => m.provider_email_id === `call-ended:in2-${trust}`)!;
      expect(inbound).toMatchObject({ sender_trusted: trust, matched_via: "caller_number" });
      // Trusted: sent for parsing (the scripted mock extractor has no line for it); untrusted: never parsed.
      expect(board.businesses[0]!.last_event).toMatch(trust ? /couldn't read a price|Quoted|called Haggle/ : /caller ID not verified|unverified sender/);
    }
  });
});

describe("the MVP demo shape: email + iMessage + Voice AI vendors (real engine, fake Inkbox ports)", () => {
  // Reads the figures out of free text, like the Claude extractor does live (no scripted winner).
  const textExtractor: { extract(i: { bodyText: string }): Promise<Record<string, unknown> & { sources: { field: "total"; source: string; excerpt: string }[] }> } = {
    async extract(i: { bodyText: string }) {
      const t = i.bodyText;
      const money = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
      const total = money(/\$?\s?([\d,]+(?:\.\d{2})?)\s*(?:total|all[- ]in)/i);
      const deposit = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*deposit|deposit (?:of )?\$\s?([\d,]+)/i);
      const veg = Number(t.match(/(\d+)\s*(?:vegetarian|veg)/i)?.[1] ?? NaN);
      return {
        available: true, price_per_head_usd: null, headcount: 40, subtotal_usd: null, delivery_fee_usd: null, delivery_included: /deliver/i.test(t) ? true : null, tax_usd: null, tax_included: true,
        total_usd: total, deposit_usd: deposit, menu_items: [], dietary_coverage: Number.isFinite(veg) ? [{ need: "vegetarian", covered: veg >= 12, count_offered: veg }] : [],
        valid_until: null, questions: [], payment_request: "none" as const, instructions_to_agent: false,
        sources: total !== null ? [{ field: "total" as const, source: "text", excerpt: `$${total} total` }] : [], missing_fields: total === null ? ["total" as const] : [], confidence: 0.9,
      };
    },
  };
  function demoEngine(config: Record<string, unknown> = {}) {
    let t = Date.now();
    const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
    const sent: { to: string; subject: string; bodyText: string }[] = [];
    const texts: { to: string; text: string }[] = [];
    const calls: { toNumber: string; reason: string }[] = [];
    const repo = new InMemoryRepository();
    const engine = new HaggleEngine({
      repo, now: clock.now, extractor: textExtractor as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
      email: { async send(m) { sent.push(m); return { providerId: `em_${sent.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${sent.length}@haggle.test>` }; } },
      imessage: { async send(r) { texts.push(r); return { messageId: `im_${texts.length}` }; } },
      phone: { async placeCall(r) { calls.push(r); return { callId: `call_${calls.length}` }; } },
      config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 50_000, maxRounds: 2, ...config },
    });
    return { engine, repo, clock, sent, texts, calls };
  }
  const trusted = (expected: string) => ({ trusted: true as const, address: expected, reason: "trusted" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });

  it("a callback needs a negotiation round left (decision 37): a one-round deal refuses it with a fix hint", async () => {
    const { engine, repo, calls } = demoEngine();
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await engine.deal({ request, budget_usd, max_rounds: 1, businesses: [{ name: "Mission Eats", phone: "+14155550104" }, { name: "Harbor Table", email: "harbor-table-sf@inkboxmail.test" }] });
    const mission = (await repo.getBusinesses(deal.job_id)).find((b) => b.name === "Mission Eats")!;
    expect(await engine.callbackProposals(deal.job_id)).toEqual([]);
    await expect(engine.placeCallback(deal.job_id, mission.business_id, "human")).rejects.toMatchObject({ code: "no_rounds_left", fix: expect.stringMatching(/max_rounds 2/) });
    expect(calls.filter((c) => /called earlier/.test(c.reason ?? ""))).toHaveLength(0);
  });

  it("collects all three; a justified, human-authorized callback cites the real competing quote; best value picks the winner", async () => {
    const { engine, repo, clock, sent, texts, calls } = demoEngine({ callDelayMs: 60_000, globalPaymentCapCents: 500_000 }); // the fake extractor reads no deposits: full totals must fit the ceiling
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    // A callback needs a negotiation round left (decision 37: max_rounds 2). A fourth business that never
    // answers keeps collection open, so the automatic counter round (which may call phone vendors itself,
    // decision 13) hasn't run and the human-authorized callback is what negotiates with Mission Eats.
    const deal = await engine.deal({ request, budget_usd, max_rounds: 2, businesses: [
      { name: "Harbor Table", email: "harbor-table-sf@inkboxmail.test" },
      { name: "Sunset Kitchen", phone: "+14155550111", channel: "imessage" },
      { name: "Mission Eats", phone: "+14155550104" },
      { name: "Quiet Bistro", email: "quiet-bistro@inkboxmail.test" },
    ] });
    expect(deal.contacted.map((c) => [c.business, c.channel])).toEqual(expect.arrayContaining([["Harbor Table", "email"], ["Sunset Kitchen", "imessage"]]));
    expect(sent).toHaveLength(2); // the two email RFQs
    expect(texts).toEqual([{ to: "+14155550111", text: expect.stringMatching(/^Hi Sunset Kitchen, I'm an AI assistant for a customer\..{0,140}HG-/), idempotencyKey: expect.any(String) }]);
    expect(texts[0]!.text.length).toBeLessThanOrEqual(159);
    expect(calls).toHaveLength(0); // scheduled, not yet placed

    // Email vendor replies in thread; the text vendor replies by iMessage.
    const rfq = (await repo.getBusinesses(deal.job_id)).find((b) => b.name === "Harbor Table")!.rfq_message_id!;
    await engine.ingest({ providerEventId: "e1", eventType: "message.received", providerEmailId: "in_1", threadId: "t1", messageId: "<in_1@x>", inReplyTo: [rfq], references: [rfq], from: "harbor-table-sf@inkboxmail.test", to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText: "Happy to help: $1,150 total, 12 vegetarian, delivered. $345 deposit.", attachments: [], attachmentsDownloadUrl: null }, trusted);
    expect((await engine.ingestIMessage({ messageId: "im_in_1", from: "+14155550111", text: "We can do $1,080 total, 14 vegetarian, delivered, $100 deposit", isGroup: false })).outcome).toBe("stored");
    await engine.advanceJob(deal.job_id);

    // After the delay the Voice AI call goes out, AI-disclosed. The first call only collects a quote.
    clock.advance(61_000);
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.reason).toMatch(/Hi, I'm an AI assistant calling on behalf of a customer/);
    expect(calls[0]!.reason).not.toMatch(/Haggle/);
    expect(calls[0]!.reason).toMatch(/Do not mention other businesses or prices/);
    expect(calls[0]!.reason).not.toMatch(/\$1,080/);
    expect((await engine.ingestCall({ callId: "call_1", outcome: "completed", transcript: "haggle: I'm an AI assistant...\nremote: For you, $1,150 total all-in, 12 vegetarian, delivery included, $150 deposit." })).outcome).toBe("stored");
    await engine.advanceJob(deal.job_id);

    // Evidence justifies one callback: a real, eligible, cheaper quote ($1,080 by iMessage) exists.
    let board = await engine.getQuotes(deal.job_id);
    expect(board.callbacks).toEqual([expect.objectContaining({ business: "Mission Eats", their_total_usd: 1150, basis_total_usd: 1080, basis_business: "Sunset Kitchen", round: 2 })]);
    expect(calls).toHaveLength(1); // proposed, never placed without a human

    // A human authorizes it: one AI-disclosed call citing only that real total.
    await engine.placeCallback(deal.job_id, board.callbacks![0]!.business_id, "human via approval form");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.reason).toMatch(/AI assistant who called earlier/);
    expect(calls[1]!.reason).toMatch(/real quote of \$1,080 total/);
    await expect(engine.placeCallback(deal.job_id, board.callbacks![0]!.business_id, "again")).rejects.toMatchObject({ code: "callback_not_justified" }); // once
    expect((await engine.ingestCall({ callId: "call_2", outcome: "completed", transcript: "haggle: Thanks again...\nremote: OK, we can do $1,040 total all-in, 12 vegetarian, delivery included, $150 deposit." })).outcome).toBe("stored");
    await engine.advanceJob(deal.job_id);

    board = await engine.getQuotes(deal.job_id);
    const by = (n: string) => board.quotes.find((q) => q.business === n && q.status === "current")!;
    expect(by("Mission Eats")).toMatchObject({ channel: "phone", total_usd: 1040, negotiated_from: 1150, verdict: "compliant" });
    expect(by("Sunset Kitchen")).toMatchObject({ channel: "imessage", total_usd: 1080, verdict: "compliant" });
    expect(by("Harbor Table")).toMatchObject({ channel: "email", total_usd: 1150 });
    expect(board.recommended_quote_id).toBe(by("Mission Eats").quote_id);
    expect(board.negotiation).toEqual(expect.arrayContaining([expect.objectContaining({ business: "Mission Eats", round: 2, target_total_usd: 1080, outcome_total_usd: 1040 })]));
    expect(board.value!.explanation!.winner).toMatch(/^Mission Eats: best value .* lowest all-in total \$1,040 \(negotiated down from \$1,150\)/);
    expect(board.callbacks).toEqual([]); // nothing more to justify
  });

  // Regression (live job_dec51a570667400eae64, 2026-10-18): the confirming answer added "$250 extra for
  // delivery"; the revision kept $4,500 and dropped the fee. The all-in total must become $4,750.
  it("a confirmation that states a new extra adds it to the all-in total, with its source", async () => {
    const { engine } = demoEngine();
    const { budget_usd: _b, ...request } = GOLDEN_REQUEST;
    const deal = await engine.deal({ request: { ...request, quantity: 200, requirements: [{ id: "veg40", kind: "dietary", text: "At least 40 vegetarian meals", hard: true, min_count: 40 }] }, budget_usd: 5000, businesses: [{ name: "Sunset Kitchen", phone: "+14155550111", channel: "imessage" }] });
    const real = textExtractor.extract.bind(textExtractor);
    // What the live model returned for each text.
    textExtractor.extract = async (i) => {
      const base = await real(i);
      if (/4\.5k/.test(i.bodyText)) return { ...base, total_usd: 4500, deposit_usd: 1000, delivery_included: null, dietary_coverage: [], sources: [{ field: "total" as const, source: "iMessage text", excerpt: "$4.5k total" }, { field: "deposit" as const, source: "iMessage text", excerpt: "$1k deposit" }] } as never;
      return { ...base, total_usd: null, deposit_usd: null, delivery_fee_usd: 250, delivery_included: false, dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 40 }], sources: [{ field: "delivery_fee" as const, source: "iMessage text", excerpt: "$250 extra for delivery" }] } as never;
    };
    try {
      await engine.ingestIMessage({ messageId: "im_a1", from: "+14155550111", text: "$4.5k total, $1k deposit", isGroup: false });
      await engine.advanceJob(deal.job_id);
      await engine.ingestIMessage({ messageId: "im_a2", from: "+14155550111", text: "yes 40 veggie meals . $250 extra for delivery", isGroup: false });
      await engine.advanceJob(deal.job_id);
    } finally {
      textExtractor.extract = real;
    }
    const q = (await engine.getQuotes(deal.job_id)).quotes.find((x) => x.status === "current")!;
    expect(q).toMatchObject({ total_usd: 4750, deposit_usd: 1000, round: 1, meets_requirements: true, delivery_usd: 250 });
    expect(q.source).toMatch(/^computed from stated total \+ delivery fee/);
    expect(q.flags).not.toContain("delivery_unclear");
  });

  it("the same number on two open jobs: a reply quoting HG-<code> goes to that job, else to the latest contact", async () => {
    const { engine, repo, clock, texts } = demoEngine();
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const older = await engine.deal({ request, budget_usd, businesses: [{ name: "Sunset Kitchen", phone: "+14155550111", channel: "imessage" }] });
    clock.advance(60_000);
    const newer = await engine.deal({ request, budget_usd, businesses: [{ name: "Sunset Kitchen", phone: "+14155550111", channel: "imessage" }] });
    const olderCode = (await repo.getJob(older.job_id))!.short_code;
    expect(texts[0]!.text).toContain(`HG-${olderCode}`);
    expect(await engine.ingestIMessage({ messageId: "im_x1", from: "+14155550111", text: `For HG-${olderCode}: $1,080 total, 14 vegetarian, delivered`, isGroup: false })).toMatchObject({ jobId: older.job_id, outcome: "stored" });
    expect(await engine.ingestIMessage({ messageId: "im_x2", from: "+14155550111", text: "$1,050 total, 14 vegetarian, delivered", isGroup: false })).toMatchObject({ jobId: newer.job_id, outcome: "stored" });
    expect(await engine.ingestIMessage({ messageId: "im_x3", from: "+14155550999", text: "$1 total", isGroup: false })).toMatchObject({ jobId: null }); // unknown sender never lands on a job
  });

  it("an unanswered email escalates to one Voice AI call when the business has an allowlisted phone", async () => {
    const { engine, clock, calls } = demoEngine({ escalateEmailToCallAfterMs: 5 * 60_000 });
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Quiet Bistro", email: "quiet@inkboxmail.test", phone: "+14155550122" }] });
    clock.advance(4 * 60_000);
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(0);
    clock.advance(2 * 60_000);
    await engine.advanceJob(deal.job_id);
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.reason).toMatch(/emailed earlier/);
  });

  // Regression (live job_8eebfe8012ff43a2bf0a, 2026-10-18): iPhone call screening answered first, Inkbox
  // labelled Haggle's turns "local", and the extractor (email-trained) sourced the figures as "email body".
  it("a live-shaped call: provenance says call transcript and the board quotes the priced line, not call screening", async () => {
    const { engine } = demoEngine();
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await engine.deal({ request, budget_usd: 8000, businesses: [{ name: "Mission Eats (demo)", phone: "+14155550104" }] });
    await engine.advanceJob(deal.job_id);
    const real = textExtractor.extract.bind(textExtractor);
    textExtractor.extract = async (i) => { const e = await real(i); return { ...e, sources: e.sources.map((x) => ({ ...x, source: "email body" })) }; };
    try {
      const transcript = [
        "remote: If you record your name and reason for calling",
        "local: Hi, this is Haggle, an AI assistant calling for a customer to ask for a catering quote. Please call or email us back.",
        "remote: Hello",
        "local: Hi, this is Haggle, an AI assistant calling for a customer about a quote for catering. Do you have a minute?",
        "remote: Yes I do",
        "remote: For 40 meals including 12 vegetarian it'll be $6,200 total with delivery, no deposit",
        "local: Great, thank you!",
      ].join("\n");
      expect((await engine.ingestCall({ callId: "call_1", outcome: "completed", transcript })).outcome).toBe("stored");
      await engine.advanceJob(deal.job_id);
    } finally {
      textExtractor.extract = real;
    }
    const board = await engine.getQuotes(deal.job_id);
    expect(board.quotes[0]).toMatchObject({ channel: "phone", total_usd: 6200, source: "call transcript" });
    expect(board.businesses[0]!.transcript_snippet).toBe("Mission Eats (demo): For 40 meals including 12 vegetarian it'll be $6,200 total with delivery, no deposit");
  });

  it("an iMessage quote is sourced as iMessage text; a refused RFQ says exactly why (Inkbox code)", async () => {
    const { engine, repo } = demoEngine();
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Sunset Kitchen (demo)", phone: "+14155550111", channel: "imessage" }] });
    expect((await engine.ingestIMessage({ messageId: "im_in_1", from: "+14155550111", text: "We can do $1,080 total, 14 vegetarian, delivered, $100 deposit", isGroup: false })).outcome).toBe("stored");
    await engine.advanceJob(deal.job_id);
    expect((await engine.getQuotes(deal.job_id)).quotes[0]).toMatchObject({ channel: "imessage", total_usd: 1080, source: "iMessage text" });

    const refusing = new HaggleEngine({ ...(engine as unknown as { d: ConstructorParameters<typeof HaggleEngine>[0] }).d, repo, imessage: { async send() { throw new Error('HTTP 409: {"error":"imessage_awaiting_inbound","message":"… hasn\'t sent a message or reaction yet"}'); } } });
    const d2 = await refusing.deal({ request, budget_usd, businesses: [{ name: "Sunset Kitchen (demo)", phone: "+14155550111", channel: "imessage" }], client_request_id: "refused" });
    const b = (await refusing.getQuotes(d2.job_id)).businesses[0]!;
    expect(b.last_event).toBe("Couldn't text Sunset Kitchen (demo): connected, but they haven't texted the agent's iMessage line yet: they must send it one message (to the line Inkbox assigned, not the router) before Haggle can text first");
    expect(b.last_event).not.toMatch(/connect @/);
  });

  // Regression (live job_63ffe01e280141ce9e4b, 2026-10-18): the reply "6000 bucks + 200 in delivery/full
  // setup + 500 in tax" never mentioned vegetarian, the extractor said "vegetarian: not covered", and the
  // only quote was rejected as "can't cover it". Silence is unknown: ask once by text, then the answer
  // revises the same quote.
  it("a text quote that doesn't mention a hard requirement gets one confirming text, and the answer completes the quote", async () => {
    const { engine, texts } = demoEngine();
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await engine.deal({ request, budget_usd: 8000, businesses: [{ name: "Sunset Kitchen (demo)", phone: "+14155550111", channel: "imessage" }] });
    const real = textExtractor.extract.bind(textExtractor);
    // Like the live model: an entry for every requested need, silence turned into covered=false.
    textExtractor.extract = async (i) => { const e = await real(i); return { ...e, dietary_coverage: (e.dietary_coverage as unknown[]).length ? e.dietary_coverage : [{ need: "vegetarian", covered: false, count_offered: null }] }; };
    try {
      expect((await engine.ingestIMessage({ messageId: "im_q", from: "+14155550111", text: "6,700 total all-in: 6000 bucks + 200 in delivery/full setup + 500 in tax", isGroup: false })).outcome).toBe("stored");
      await engine.advanceJob(deal.job_id);
      let board = await engine.getQuotes(deal.job_id);
      expect(board.quotes[0]).toMatchObject({ total_usd: 6700, verdict: "incomplete", source: "iMessage text" });
      expect(board.quotes[0]!.flags).not.toContain("requirement_unmet");
      // Soft requirements (decision 1): an unconfirmed requirement is a caveat, never a rejection.
      expect(board.quotes[0]).toMatchObject({ meets_requirements: false });
      expect(board.rejected).toEqual([]);
      expect(board.state).toBe("collecting"); // waits for the answer instead of failing
      expect(texts.at(-1)!.text).toMatch(/^Thanks! Can you confirm: At least 12 vegetarian meals\? HG-/);

      expect((await engine.ingestIMessage({ messageId: "im_a", from: "+14155550111", text: "Yes, 45 vegetarian", isGroup: false })).outcome).toBe("stored");
      await engine.advanceJob(deal.job_id);
      board = await engine.getQuotes(deal.job_id);
      const q = board.quotes.find((x) => x.status === "current")!;
      expect(q).toMatchObject({ total_usd: 6700, verdict: "compliant", eligible: true, round: 1 }); // a confirm-once answer is not a counter round (decision 16)
      expect(texts.filter((t) => /confirm/.test(t.text))).toHaveLength(1); // asked once
      // Live regression: a reply that adds nothing (just the reference code) keeps the vendor "quoted", no noise flags.
      expect((await engine.ingestIMessage({ messageId: "im_b", from: "+14155550111", text: "HG-RMT2", isGroup: false })).outcome).toBe("stored");
      await engine.advanceJob(deal.job_id);
      const after = await engine.getQuotes(deal.job_id);
      expect(after.businesses[0]).toMatchObject({ status: "quoted" });
      expect(after.quotes.find((x) => x.status === "current")).toMatchObject({ total_usd: 6700, verdict: "compliant" });
    } finally {
      textExtractor.extract = real;
    }
  });

  it("an unanswered call is shown as no reply, makes no quote, and its redelivery changes nothing", async () => {
    const { engine, calls } = demoEngine();
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Quiet Bistro", phone: "+14155550122" }] });
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(1);
    const ended = { callId: "call_1", outcome: "no_answer" as const, transcript: "" };
    expect((await engine.ingestCall(ended)).outcome).toBe("call:no_answer");
    expect((await engine.ingestCall(ended)).outcome).toBe("duplicate");
    const board = await engine.getQuotes(deal.job_id);
    expect(board.quotes).toHaveLength(0);
    expect(board.businesses[0]).toMatchObject({ name: "Quiet Bistro", status: "no_reply" });
    expect(board.businesses[0]!.transcript_snippet).toBeUndefined();
  });

  it("a text from an unknown number, or one never texted, is not a business reply", async () => {
    const { engine } = demoEngine();
    expect((await engine.ingestIMessage({ messageId: "x", from: "+14155550999", text: "$1 total!", isGroup: false })).outcome).toBe("not_approver");
  });
});
