// POST /webhooks/inkbox route logic (src/webhook.ts) with Inkbox fakes and the real engine in live
// configuration (in-memory store, no network): signature first, quote from a signed seller reply,
// deduped redelivery, retryable trust failures, call.ended routing, and mock mode disabled.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMockEngine, disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, inkboxEmail, type QuoteExtraction } from "@haggle/engine";
import { BUYER, FakeInkbox, SECRET, signed } from "../../../packages/engine/tests/helpers/fakeInkbox.ts";
import { handleInkboxWebhook } from "../src/webhook.ts";
import type { Runtime } from "../src/runtime.ts";

const FIX = new URL("../../../fixtures/buyer/emails/", import.meta.url);
const sellerText = (JSON.parse(readFileSync(new URL("01-clean-agent-quote.json", FIX), "utf8")) as { text: string }).text;
const SELLER = "bay@inkboxmail.test";

const extraction: QuoteExtraction = {
  available: true, price_per_head_usd: null, headcount: 40, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true,
  total_usd: 995, deposit_usd: 5, menu_items: ["lunch"], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }], valid_until: "2026-10-19", questions: [],
  payment_request: "none", instructions_to_agent: false, sources: [{ field: "total", source: "email body", excerpt: "Total $995" }], missing_fields: [], confidence: 0.9,
};

async function liveRuntime() {
  const api = new FakeInkbox();
  const repo = new InMemoryRepository();
  const engine = new HaggleEngine({
    repo, email: inkboxEmail(api, BUYER), extractor: { extract: async () => extraction }, attachments: { load: async () => [] }, brain: new StubBrain(),
    payer: disabledPayer("Payments are not enabled yet"),
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: BUYER, collectionWindowMs: 600_000, negotiationWindowMs: 300_000, approvalTtlMs: 1_800_000, globalPaymentCapCents: 500, maxRounds: 2 },
  });
  const rt: Runtime = { mode: "live", engine, missing: [], inkbox: { api, buyerMailbox: BUYER, webhookSecret: SECRET } };
  const { budget_usd, ...request } = GOLDEN_REQUEST;
  const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Bay Catering", email: SELLER }] });
  const rfqId = (await repo.getBusinesses(deal.job_id))[0]!.rfq_message_id!;
  return { api, engine, rt, deal, rfqId };
}

const event = (id: string, type: string, data: Record<string, unknown>) => JSON.stringify({ id, event_type: type, timestamp: new Date().toISOString(), data });

describe("POST /webhooks/inkbox", () => {
  it("rejects a bad signature with 401 before reading anything", async () => {
    const { rt, api } = await liveRuntime();
    const raw = event("evt_bad", "message.received", { message: { id: "in_1" } });
    const r = await handleInkboxWebhook(rt, raw, signed(raw, { secret: "whsec_b3RoZXI" })); // fake wrong key gitleaks:allow
    expect(r).toMatchObject({ status: 401, body: { error: "invalid_signature" } });
    expect(api.sent).toHaveLength(1); // only the RFQ
  });

  it("a signed seller reply becomes a quote; redelivery is deduped", async () => {
    const { rt, api, engine, deal, rfqId } = await liveRuntime();
    const detail = api.reply(SELLER, rfqId, sellerText);
    const raw = event("evt_r1", "message.received", { message: { id: detail.id }, agent_identities: [{ bucket: "from", address: SELLER }] });
    const first = await handleInkboxWebhook(rt, raw, signed(raw));
    expect(first).toMatchObject({ status: 200, jobId: deal.job_id, outcome: "stored" });
    const again = await handleInkboxWebhook(rt, raw, signed(raw));
    expect(again).toMatchObject({ status: 200, outcome: "duplicate" });
    const board = await engine.getQuotes(deal.job_id);
    expect(board.quotes).toHaveLength(1);
    expect(board.quotes[0]).toMatchObject({ business: "Bay Catering", total_usd: 995, channel: "email" });
  });

  it("answers 503 (so Inkbox retries) when sender verification is temporarily unavailable", async () => {
    const { rt, api, rfqId } = await liveRuntime();
    const detail = api.reply(SELLER, rfqId, sellerText);
    api.listError = new Error("ECONNRESET");
    const raw = event("evt_r2", "message.received", { message: { id: detail.id }, agent_identities: [{ bucket: "from", address: SELLER }] });
    expect(await handleInkboxWebhook(rt, raw, signed(raw))).toMatchObject({ status: 503, body: { error: "retry later" } });
  });

  it("ignores mail not addressed to the buyer and malformed payloads", async () => {
    const { rt, api } = await liveRuntime();
    const other = api.reply(SELLER, "<x@y>", "hi");
    other.toAddresses = ["someone-else@inkboxmail.test"];
    const raw = event("evt_o", "message.received", { message: { id: other.id } });
    expect(await handleInkboxWebhook(rt, raw, signed(raw))).toMatchObject({ status: 200, outcome: "not_for_buyer" });
    const bad = event("evt_b", "message.received", {});
    expect((await handleInkboxWebhook(rt, bad, signed(bad))).status).toBe(400);
  });

  it("routes call.ended to the engine and acknowledges unknown event types", async () => {
    const { rt } = await liveRuntime();
    const raw = event("evt_c", "call.ended", { call: { id: "call_unknown" }, outcome: "completed", transcript: { entries: [{ party: "remote", text: "$1,070 total" }] } });
    expect(await handleInkboxWebhook(rt, raw, signed(raw))).toMatchObject({ status: 200, outcome: "unknown_call" });
    const other = event("evt_x", "imessage.received", {});
    expect(await handleInkboxWebhook(rt, other, signed(other))).toMatchObject({ status: 200, outcome: "ignored" });
  });

  it("is disabled (404) in mock mode", async () => {
    const m = createMockEngine();
    const raw = event("evt_m", "message.received", {});
    expect(await handleInkboxWebhook({ mode: "mock", engine: m.engine, missing: [] }, raw, signed(raw))).toMatchObject({ status: 404 });
  });
});
