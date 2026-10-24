// POST /webhooks/inkbox: message.bounced / message.failed for Haggle's own outbound email, and
// HTML-only replies. Real engine (live config, in-memory store), Inkbox fakes; no network.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, inkboxEmail, type InkboxMessageDetail, type QuoteExtraction } from "@haggle/engine";
import { BUYER, FakeInkbox, SECRET, signed } from "../../../packages/engine/tests/helpers/fakeInkbox.ts";
import { handleInkboxWebhook } from "../src/webhook.ts";
import type { Runtime } from "../src/runtime.ts";

const SELLER = "bay@inkboxmail.test";
const seen: string[] = [];
const extraction = (total: number | null): QuoteExtraction => ({
  available: true, price_per_head_usd: null, headcount: 40, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true,
  total_usd: total, deposit_usd: null, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }], valid_until: null, questions: [],
  payment_request: "none", instructions_to_agent: false, sources: total ? [{ field: "total", source: "email body", excerpt: `$${total} total` }] : [], missing_fields: [], confidence: 0.9,
});

async function liveRuntime() {
  const api = new FakeInkbox();
  const repo = new InMemoryRepository();
  const engine = new HaggleEngine({
    repo, email: inkboxEmail(api, BUYER), brain: new StubBrain(), payer: disabledPayer("off"), attachments: { load: async () => [] },
    extractor: { extract: async (i) => { seen.push(i.bodyText); const m = i.bodyText.match(/\$([\d,]+) total/); return extraction(m ? Number(m[1]!.replace(/,/g, "")) : null); } },
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: BUYER, collectionWindowMs: 600_000, negotiationWindowMs: 300_000, approvalTtlMs: 1_800_000, globalPaymentCapCents: 500_000, maxRounds: 1 },
  });
  const rt = { mode: "live", engine, missing: [], inkbox: { api, buyerMailbox: BUYER, webhookSecret: SECRET, senderTrust: { policy: "outbound-verified" } } } as unknown as Runtime;
  const { budget_usd, ...request } = GOLDEN_REQUEST;
  const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Bay Catering", email: SELLER }] });
  const rfqRow = (await repo.listMessages(deal.job_id)).find((m) => m.direction === "out")!;
  return { api, repo, engine, rt, deal, rfqRow };
}

const event = (id: string, type: string, data: Record<string, unknown>) => JSON.stringify({ id, event_type: type, timestamp: new Date().toISOString(), data });

describe("message.bounced / message.failed", () => {
  it("a signed bounce for our RFQ suppresses the address and marks the business bounced; redelivery is a no-op", async () => {
    const { api, repo, rt, deal, rfqRow } = await liveRuntime();
    api.messages.get(rfqRow.provider_email_id!)!.status = "bounced";
    const raw = event("evt_b1", "message.bounced", { message: { id: rfqRow.provider_email_id, direction: "outbound", status: "bounced" } });
    expect(await handleInkboxWebhook(rt, raw, signed(raw))).toMatchObject({ status: 200, jobId: deal.job_id, outcome: "bounced" });
    expect((await repo.getBusinesses(deal.job_id))[0]!.status).toBe("bounced");
    expect(await repo.findSuppressions([SELLER])).toHaveLength(1);
    expect(await handleInkboxWebhook(rt, raw, signed(raw))).toMatchObject({ status: 200, outcome: "duplicate" });
  });

  it("message.failed is recorded without suppressing", async () => {
    const { api, repo, rt, rfqRow, deal } = await liveRuntime();
    api.messages.get(rfqRow.provider_email_id!)!.status = "failed";
    const raw = event("evt_f1", "message.failed", { message: { id: rfqRow.provider_email_id } });
    expect(await handleInkboxWebhook(rt, raw, signed(raw))).toMatchObject({ status: 200, outcome: "delivery_failed" });
    expect(await repo.findSuppressions([SELLER])).toEqual([]);
    expect((await repo.getBusinesses(deal.job_id))[0]!.status).toBe("contacted");
  });

  it("re-reads the message: a status that doesn't match, an inbound message, or a bad signature changes nothing", async () => {
    const { api, repo, rt, rfqRow } = await liveRuntime();
    api.messages.get(rfqRow.provider_email_id!)!.status = "delivered";
    const raw = event("evt_b2", "message.bounced", { message: { id: rfqRow.provider_email_id } });
    expect(await handleInkboxWebhook(rt, raw, signed(raw))).toMatchObject({ status: 200, outcome: "status_mismatch:delivered" });
    const reply = api.reply(SELLER, rfqRow.rfc_message_id!, "hi");
    const raw2 = event("evt_b3", "message.bounced", { message: { id: reply.id } });
    expect(await handleInkboxWebhook(rt, raw2, signed(raw2))).toMatchObject({ status: 200, outcome: "not_buyer_outbound" });
    const raw3 = event("evt_b4", "message.bounced", { message: { id: rfqRow.provider_email_id } });
    expect(await handleInkboxWebhook(rt, raw3, signed(raw3, { secret: "whsec_b3RoZXI" }))).toMatchObject({ status: 401 }); // fake wrong key gitleaks:allow
    expect(await handleInkboxWebhook(rt, event("evt_b5", "message.bounced", {}), signed(event("evt_b5", "message.bounced", {})))).toMatchObject({ status: 400 });
    expect(await repo.findSuppressions([SELLER])).toEqual([]);
  });
});

describe("HTML-only replies", () => {
  it("a reply with only an HTML part is read from its text, quoted history dropped", async () => {
    const { api, rt, engine, deal, rfqRow } = await liveRuntime();
    const d = api.reply(SELLER, rfqRow.rfc_message_id!, "") as InkboxMessageDetail;
    d.bodyText = null;
    d.bodyHtml = `<div>Yes, <b>$1,150 total</b>.</div><div class="gmail_quote">On Thu, Oct 22, 2026 at 10:15 AM Haggle &lt;${BUYER}&gt; wrote:<blockquote>Budget: up to $2,000 total</blockquote></div>`;
    const raw = event("evt_h1", "message.received", { message: { id: d.id }, agent_identities: [{ bucket: "from", address: SELLER }] });
    expect(await handleInkboxWebhook(rt, raw, signed(raw))).toMatchObject({ status: 200, outcome: "stored" });
    await engine.advanceJob(deal.job_id);
    expect(seen.at(-1)).toBe("Yes, $1,150 total.");
    expect((await engine.getQuotes(deal.job_id)).quotes.map((q) => q.total_usd)).toEqual([1150]);
  });
});
