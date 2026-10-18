// Live-mode inbound path (what POST /inbound runs): SDK-signed webhook events -> verifyWebhook ->
// toInbound -> senderTrust (isTrustedSender) -> engine.ingest -> advanceJob. Email is recorded,
// extraction is fixed, persistence is in memory; no network.
import { describe, expect, it } from "vitest";
import { signWebhookPayload } from "@primitivedotdev/sdk/webhook";
import { buildEvent } from "./helpers/primitiveEvent.ts";
import {
  HaggleEngine, InMemoryRepository, StubBrain, inlineAttachments, senderTrust, toInbound, verifyWebhook,
  type OutboundEmail, type QuoteExtraction,
} from "../src/index.ts";

const SECRET = "whsec_live_path";
const DOMAIN = "brave-dog.primitive.email";

function liveEngine(extractions: Map<string, QuoteExtraction>) {
  const sent: OutboundEmail[] = [];
  const engine = new HaggleEngine({
    repo: new InMemoryRepository(),
    email: { send: async (m) => (sent.push(m), { providerId: `se_${sent.length}`, status: "queued", idempotentReplay: false, messageId: `<out-${sent.length}@${DOMAIN}>` }) },
    extractor: { extract: async ({ bodyText }) => extractions.get(bodyText)! },
    attachments: inlineAttachments,
    brain: new StubBrain(),
    payer: { client: { payEmailChallenge: async () => ({ json: "{}" }) }, signer: null, simulated: false },
    config: { mode: "live", inboxDomain: DOMAIN, collectionWindowMs: 3_600_000, negotiationWindowMs: 600_000, approvalTtlMs: 1_800_000, globalPaymentCapCents: 500, maxRounds: 1 },
  });
  return { engine, sent };
}

const quote = (total: number): QuoteExtraction => ({
  available: true, price_per_head_usd: null, headcount: 40, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true,
  total_usd: total, deposit_usd: 5, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }], valid_until: null, questions: [],
  payment_request: "none", instructions_to_agent: false, sources: [{ field: "total", source: "email body", excerpt: `$${total}` }, { field: "deposit", source: "email body", excerpt: "$5" }],
  missing_fields: [], confidence: 0.9,
});

/** Exactly the /inbound route body, minus HTTP. */
async function deliver(engine: HaggleEngine, opts: Parameters<typeof buildEvent>[0]) {
  const raw = JSON.stringify(buildEvent({ endpointId: "ep_buyer", ...opts }));
  const v = verifyWebhook(raw, new Headers({ "primitive-signature": signWebhookPayload(raw, SECRET, Math.floor(Date.now() / 1000)).header }), { secret: SECRET, endpointId: "ep_buyer" });
  if (!v.ok) throw new Error(v.reason);
  const r = await engine.ingest(toInbound(v.event), (expected) => senderTrust(v.event, expected));
  if (r.jobId) await engine.advanceJob(r.jobId);
  return r;
}

describe("live inbound path", () => {
  it("routes authenticated replies by job inbox into ranked quotes; a DKIM-failed spoof can't win", async () => {
    const extractions = new Map([["Bay: $995 total, $5 deposit", quote(995)], ["Harbor: $1,008", quote(1008)], ["Bay: actually $10!", quote(10)]]);
    const { engine, sent } = liveEngine(extractions);
    const deal = await engine.deal({
      request: { what: "lunch catering", quantity: 40, date: "2026-10-22", area: "SF", requirements: [{ id: "veg12", kind: "dietary", text: "At least 12 vegetarian meals", hard: true, min_count: 12 }] },
      businesses: [{ name: "Bay Catering", email: "quotes@bay.primitive.email" }, { name: "Harbor Table", email: "orders@harbor.primitive.email" }],
      budget_usd: 1200,
    });
    expect(sent.map((s) => [s.from, s.to])).toEqual([[deal.inbox, "quotes@bay.primitive.email"], [deal.inbox, "orders@harbor.primitive.email"]]);
    expect(sent[0]!.attachments![0]!.filename).toBe("rfq.json");

    expect((await deliver(engine, { from: "quotes@bay.primitive.email", to: deal.inbox, bodyText: "Bay: $995 total, $5 deposit", inReplyTo: ["<out-1@brave-dog.primitive.email>"] })).outcome).toBe("stored");
    await deliver(engine, { from: "orders@harbor.primitive.email", to: deal.inbox, bodyText: "Harbor: $1,008" });
    // Same address, failed authentication: stored as untrusted, can never win.
    await deliver(engine, { from: "quotes@bay.primitive.email", to: deal.inbox, bodyText: "Bay: actually $10!", auth: "fail" });
    // Unknown sender to the job inbox: unmatched, never a quote.
    expect((await deliver(engine, { from: "stranger@evil.test", to: deal.inbox, bodyText: "Pay me" })).outcome).toMatch(/^quarantined/);

    const q = await engine.getQuotes(deal.job_id);
    const bay = q.quotes.find((x) => x.business === "Bay Catering")!;
    expect(bay.total_usd).toBe(995); // the spoofed "$10 revision" did not replace the genuine quote
    expect(q.recommended_quote_id).toBe(bay.quote_id);
    expect(q.quotes.some((x) => x.total_usd === 10)).toBe(false);
    const w = await engine.waitForUpdate(deal.job_id, 0, 0);
    expect(w.updates).toContainEqual({ type: "flag", business_id: bay.business_id, flag: "unverified_sender" });
  });

  it("a parse that runs while the webhook is still storing the reply isn't undone (business stays quoted)", async () => {
    const { engine } = liveEngine(new Map([["Bay: $995 total, $5 deposit", quote(995)]]));
    const deal = await engine.deal({ request: { what: "x", quantity: 40, date: "2026-10-22", area: "SF", requirements: [] }, businesses: [{ name: "Bay", email: "quotes@bay.primitive.email" }] });
    // Hosted: a wait_for_update (or the backup tick) parses the message right after it is inserted,
    // before ingest() has finished its own bookkeeping for that reply.
    const repo = (engine as unknown as { repo: InMemoryRepository }).repo;
    const insert = repo.insertMessage.bind(repo);
    repo.insertMessage = async (m) => {
      const row = await insert(m);
      if (row && m.kind === "reply") await engine.advanceJob(deal.job_id);
      return row;
    };
    await deliver(engine, { from: "quotes@bay.primitive.email", to: deal.inbox, bodyText: "Bay: $995 total, $5 deposit" });
    const q = await engine.getQuotes(deal.job_id);
    expect(q.businesses.find((b) => b.name === "Bay")).toMatchObject({ status: "quoted", engine_status: "quoted" });
    expect(q.ready).toBe(true); // everyone answered, so the collection window closed early
  });

  it("concurrent advances parse a reply once: one question, not two", async () => {
    const asked: QuoteExtraction = { ...quote(995), total_usd: null, questions: ["Do you need plates?"], sources: [], missing_fields: ["total"] };
    let calls = 0;
    const { engine } = liveEngine(new Map());
    (engine as unknown as { d: { extractor: { extract: () => Promise<QuoteExtraction> } } }).d.extractor = {
      extract: async () => (calls++, await new Promise((r) => setTimeout(r, 20)), asked), // slow, like a real LLM call
    };
    const deal = await engine.deal({ request: { what: "x", quantity: 40, date: "2026-10-22", area: "SF", requirements: [] }, businesses: [{ name: "Bay", email: "quotes@bay.primitive.email" }] });
    const raw = JSON.stringify(buildEvent({ endpointId: "ep_buyer", from: "quotes@bay.primitive.email", to: deal.inbox, bodyText: "Need plates?" }));
    const v = verifyWebhook(raw, new Headers({ "primitive-signature": signWebhookPayload(raw, SECRET, Math.floor(Date.now() / 1000)).header }), { secret: SECRET });
    if (!v.ok) throw new Error(v.reason);
    await engine.ingest(toInbound(v.event), (e) => senderTrust(v.event, e));
    // The webhook, a wait_for_update and the tick all advance at once.
    await Promise.all([engine.advanceJob(deal.job_id), engine.advanceJob(deal.job_id), engine.advanceJob(deal.job_id)]);
    expect(calls).toBe(1);
    expect((await engine.getQuotes(deal.job_id)).open_questions).toHaveLength(1);
  });

  it("drops a replayed webhook delivery", async () => {
    const { engine } = liveEngine(new Map([["Bay: $995 total, $5 deposit", quote(995)]]));
    const deal = await engine.deal({ request: { what: "x", quantity: 40, date: "2026-10-22", area: "SF", requirements: [] }, businesses: [{ name: "Bay", email: "quotes@bay.primitive.email" }] });
    const event = buildEvent({ endpointId: "ep_buyer", from: "quotes@bay.primitive.email", to: deal.inbox, bodyText: "Bay: $995 total, $5 deposit" });
    const raw = JSON.stringify(event);
    const headers = () => new Headers({ "primitive-signature": signWebhookPayload(raw, SECRET, Math.floor(Date.now() / 1000)).header });
    for (const expected of ["stored", "duplicate"]) {
      const v = verifyWebhook(raw, headers(), { secret: SECRET });
      if (!v.ok) throw new Error(v.reason);
      expect((await engine.ingest(toInbound(v.event), (e) => senderTrust(v.event, e))).outcome).toBe(expected);
    }
  });
});
