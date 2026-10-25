// Live-mode inbound path (what POST /webhooks/inkbox runs): a signed Inkbox `message.received`
// webhook -> verifyInkboxWebhook -> inkboxToInbound -> inkboxSenderTrust -> engine.ingest ->
// advanceJob. Mail goes through a fake Inkbox (no network), extraction is fixed, persistence is in
// memory. Ported from the retired Primitive webhook version of this test: same scenarios.
import { describe, expect, it } from "vitest";
import { BUYER, FakeInkbox, SECRET, signed } from "./helpers/fakeInkbox.ts";
import {
  disabledPayer, HaggleEngine, InMemoryRepository, StubBrain, inkboxEmail, inkboxSenderTrust, inkboxToInbound, inlineAttachments, trustForSender, verifyInkboxWebhook,
  type QuoteExtraction,
} from "../src/index.ts";

function liveEngine(extractions: Map<string, QuoteExtraction>) {
  const api = new FakeInkbox();
  const repo = new InMemoryRepository();
  const engine = new HaggleEngine({
    repo,
    email: inkboxEmail(api, BUYER),
    extractor: { extract: async ({ bodyText }) => extractions.get(bodyText)! },
    attachments: inlineAttachments,
    brain: new StubBrain(),
    payer: disabledPayer("off"),
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: BUYER, collectionWindowMs: 3_600_000, negotiationWindowMs: 600_000, approvalTtlMs: 1_800_000, globalPaymentCapCents: 500, maxRounds: 1 },
  });
  return { engine, api, repo };
}

const quote = (total: number): QuoteExtraction => ({
  available: true, price_per_head_usd: null, headcount: 40, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true,
  total_usd: total, deposit_usd: 5, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }], valid_until: null, questions: [],
  payment_request: "none", instructions_to_agent: false, sources: [{ field: "total", source: "email body", excerpt: `$${total}` }, { field: "deposit", source: "email body", excerpt: "$5" }],
  missing_fields: [], confidence: 0.9,
});

let evt = 0;
type Env = ReturnType<typeof liveEngine>;

/**
 * A seller replies in the RFQ's thread. `spoof`: same From address, but the identity's own mailbox
 * never sent it (Inkbox can't verify it). `external`: not an Inkbox identity at all.
 */
function reply(env: Env, from: string, inReplyTo: string, body: string, o: { spoof?: boolean; external?: boolean } = {}) {
  const detail = env.api.reply(from, inReplyTo, body, [], { recordOutbound: !o.spoof && !o.external });
  const payload = { id: `evt_${++evt}`, event_type: "message.received", data: { message: { id: detail.id }, agent_identities: o.external ? [] : [{ bucket: "from", address: from }] } };
  return { detail, raw: JSON.stringify(payload) };
}

/** Exactly the webhook route body, minus HTTP. */
async function receive(env: Env, raw: string, opts: { advance?: boolean } = {}) {
  const v = verifyInkboxWebhook(raw, signed(raw), SECRET);
  if (!v.ok) throw new Error(v.reason);
  const payload = v.payload as { id: string; event_type: string; data: { message: { id: string } } };
  const detail = await env.api.get(BUYER, payload.data.message.id);
  const msg = inkboxToInbound(payload, detail);
  const trust = await inkboxSenderTrust(env.api, payload as never, detail);
  const r = await env.engine.ingest(msg, trustForSender(trust, msg.from));
  if (r.jobId && opts.advance !== false) await env.engine.advanceJob(r.jobId);
  return r;
}

async function deliver(env: Env, from: string, inReplyTo: string, body: string, o: { spoof?: boolean; external?: boolean } = {}) {
  return receive(env, reply(env, from, inReplyTo, body, o).raw);
}

const rfqId = async (env: Env, jobId: string, email: string) => (await env.repo.getBusinesses(jobId)).find((b) => b.email === email)!.rfq_message_id!;
const BAY = "bay@inkboxmail.test";
const HARBOR = "harbor@inkboxmail.test";

describe("live inbound path (Inkbox)", () => {
  it("routes verified replies by thread into ranked quotes; an unverifiable copy of a seller's address can't win", async () => {
    const extractions = new Map([["Bay: $995 total, $5 deposit", quote(995)], ["Harbor: $1,008", quote(1008)], ["Bay: actually $10!", quote(10)]]);
    const env = liveEngine(extractions);
    const deal = await env.engine.deal({
      request: { what: "lunch catering", quantity: 40, date: "2026-10-22", area: "SF", requirements: [{ id: "veg12", kind: "dietary", text: "At least 12 vegetarian meals", hard: true, min_count: 12 }] },
      businesses: [{ name: "Bay Catering", email: BAY }, { name: "Harbor Table", email: HARBOR }],
      budget_usd: 1200,
    });
    expect(env.api.sent.map((s) => [s.mailbox, s.o.to[0]])).toEqual([[BUYER, BAY], [BUYER, HARBOR]]);
    expect(env.api.sent[0]!.o.attachments![0]!.filename).toBe("rfq.json");

    const bayRfq = await rfqId(env, deal.job_id, BAY);
    expect((await deliver(env, BAY, bayRfq, "Bay: $995 total, $5 deposit")).outcome).toBe("stored");
    await deliver(env, HARBOR, await rfqId(env, deal.job_id, HARBOR), "Harbor: $1,008");
    // Same address, but Bay's own mailbox never sent it: stored as untrusted, can never win.
    await deliver(env, BAY, bayRfq, "Bay: actually $10!", { spoof: true });
    // Unknown sender with no thread signal: unmatched, never a quote.
    expect((await deliver(env, "stranger@evil.test", "", "Pay me", { external: true })).outcome).toMatch(/^quarantined/);

    const q = await env.engine.getQuotes(deal.job_id);
    const bay = q.quotes.find((x) => x.business === "Bay Catering")!;
    expect(bay.total_usd).toBe(995); // the spoofed "$10 revision" did not replace the genuine quote
    expect(q.recommended_quote_id).toBe(bay.quote_id);
    expect(q.quotes.some((x) => x.total_usd === 10)).toBe(false);
    const w = await env.engine.waitForUpdate(deal.job_id, 0, 0);
    expect(w.updates).toContainEqual({ type: "flag", business_id: bay.business_id, flag: "unverified_sender" });
  });

  it("a parse that runs while the webhook is still storing the reply isn't undone (business stays quoted)", async () => {
    const env = liveEngine(new Map([["Bay: $995 total, $5 deposit", quote(995)]]));
    const deal = await env.engine.deal({ request: { what: "x", quantity: 40, date: "2026-10-22", area: "SF", requirements: [] }, businesses: [{ name: "Bay", email: BAY }] });
    // Hosted: a wait_for_update (or the backup tick) parses the message right after it is inserted,
    // before ingest() has finished its own bookkeeping for that reply.
    const insert = env.repo.insertMessage.bind(env.repo);
    env.repo.insertMessage = async (m) => {
      const row = await insert(m);
      if (row && m.kind === "reply") await env.engine.advanceJob(deal.job_id);
      return row;
    };
    await deliver(env, BAY, await rfqId(env, deal.job_id, BAY), "Bay: $995 total, $5 deposit");
    const q = await env.engine.getQuotes(deal.job_id);
    expect(q.businesses.find((b) => b.name === "Bay")).toMatchObject({ status: "quoted", engine_status: "quoted" });
    expect(q.ready).toBe(true); // everyone answered, so the collection window closed early
  });

  it("concurrent advances parse a reply once: one question, not two", async () => {
    const asked: QuoteExtraction = { ...quote(995), total_usd: null, questions: ["Do you need plates?"], sources: [], missing_fields: ["total"] };
    let calls = 0;
    const env = liveEngine(new Map());
    (env.engine as unknown as { d: { extractor: { extract: () => Promise<QuoteExtraction> } } }).d.extractor = {
      extract: async () => (calls++, await new Promise((r) => setTimeout(r, 20)), asked), // slow, like a real LLM call
    };
    const deal = await env.engine.deal({ request: { what: "x", quantity: 40, date: "2026-10-22", area: "SF", requirements: [] }, businesses: [{ name: "Bay", email: BAY }] });
    await receive(env, reply(env, BAY, await rfqId(env, deal.job_id, BAY), "Need plates?").raw, { advance: false });
    // The webhook, a wait_for_update and the tick all advance at once.
    await Promise.all([env.engine.advanceJob(deal.job_id), env.engine.advanceJob(deal.job_id), env.engine.advanceJob(deal.job_id)]);
    expect(calls).toBe(1);
    expect((await env.engine.getQuotes(deal.job_id)).open_questions).toHaveLength(1);
  });

  it("drops a replayed webhook delivery", async () => {
    const env = liveEngine(new Map([["Bay: $995 total, $5 deposit", quote(995)]]));
    const deal = await env.engine.deal({ request: { what: "x", quantity: 40, date: "2026-10-22", area: "SF", requirements: [] }, businesses: [{ name: "Bay", email: BAY }] });
    const { raw } = reply(env, BAY, await rfqId(env, deal.job_id, BAY), "Bay: $995 total, $5 deposit");
    for (const expected of ["stored", "duplicate"]) expect((await receive(env, raw, { advance: false })).outcome).toBe(expected);
  });
});
