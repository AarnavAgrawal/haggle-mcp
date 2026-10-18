// Inkbox (v5) buyer adapter: webhook signature, in-thread sending with bounded retries, sender
// trust, signed-URL attachments, and the full email loop through the real engine. Fakes only: no
// network. Reply content comes from fixtures/buyer (seller text and the hidden-deposit PDF).
import { readFileSync } from "node:fs";
import { InkboxAPIError } from "@inkbox/sdk";
import { BUYER, FakeInkbox, SECRET, signed } from "./helpers/fakeInkbox.ts";
import { describe, expect, it } from "vitest";
import {
  ChannelSendError, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, inkboxAttachments, inkboxCallEnded, inkboxEmail, inkboxSenderTrust, inkboxToInbound, mapInkboxError, trustForSender,
  verifyInkboxWebhook, type QuoteExtraction,
} from "../src/index.ts";

const FIX = new URL("../../../fixtures/buyer/", import.meta.url);
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`emails/${name}.json`, FIX), "utf8")) as { from: string; text: string; attachments: { filename: string; content_type: string; path?: string }[] };

describe("verifyInkboxWebhook", () => {
  const body = JSON.stringify({ id: "evt_1", event_type: "message.received", timestamp: new Date().toISOString(), data: { message: { id: "in_1" }, agent_identities: [] } });
  it("accepts a valid signature on the raw body", () => {
    const v = verifyInkboxWebhook(body, signed(body), SECRET);
    expect(v).toMatchObject({ ok: true, payload: { id: "evt_1", event_type: "message.received" } });
  });
  it("rejects a tampered body, a wrong secret, a malformed signature and a stale delivery", () => {
    expect(verifyInkboxWebhook(body.replace("evt_1", "evt_2"), signed(body), SECRET)).toEqual({ ok: false, reason: "invalid_signature" });
    expect(verifyInkboxWebhook(body, signed(body, { secret: "whsec_other" }), SECRET)).toEqual({ ok: false, reason: "invalid_signature" });
    expect(verifyInkboxWebhook(body, new Headers({ "x-inkbox-signature": "sha256=abc", "x-inkbox-request-id": "req_1", "x-inkbox-timestamp": "1" }), SECRET)).toEqual({ ok: false, reason: "invalid_signature" });
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(verifyInkboxWebhook(body, signed(body, { ts: old }), SECRET)).toEqual({ ok: false, reason: "stale_timestamp" });
  });
});

describe("inkboxEmail", () => {
  it("sends from the buyer mailbox, threads replies, and retries a 503 with the same idempotency key", async () => {
    const api = new FakeInkbox();
    api.failNext = [503];
    const email = inkboxEmail(api, BUYER, { sleep: async () => {} });
    const out = await email.send({ from: BUYER, to: "a@b.test", subject: "[HG-AB12] Quote request: lunch", bodyText: "hi", idempotencyKey: "counter:job_1:biz_1:r2", thread: { inReplyTo: "<x@b.test>", references: [] }, attachments: [{ filename: "counter.json", contentType: "application/json", content: new TextEncoder().encode("{}") }] });
    expect(out.messageId).toBe("<m_1@inkbox.test>");
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]!.o).toMatchObject({ to: ["a@b.test"], subject: "Re: [HG-AB12] Quote request: lunch", inReplyToMessageId: "<x@b.test>", idempotencyKey: "counter:job_1:biz_1:r2" });
    expect(api.sent[0]!.o.attachments![0]).toMatchObject({ filename: "counter.json", contentBase64: "e30=" });
    await expect(email.send({ from: "other@x.test", to: "a@b.test", subject: "s", bodyText: "b", idempotencyKey: "rfq:job_1:biz_1" })).rejects.toThrow(/buyer identity/);
  });
  it("does not retry a 4xx, and reports it as a classified, non-retryable send failure", async () => {
    const api = new FakeInkbox();
    api.failNext = [422];
    const err = await inkboxEmail(api, BUYER, { sleep: async () => {} }).send({ from: BUYER, to: "a@b.test", subject: "s", bodyText: "b", idempotencyKey: "rfq:job_1:biz_1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelSendError);
    expect(err).toMatchObject({ reason: "invalid_address", retryable: false });
    expect(api.sent).toHaveLength(0);
  });
  it("maps Inkbox error codes: rate limits and capacity retry later, blocked / opted-out recipients move on", () => {
    expect(mapInkboxError(new InkboxAPIError(429, { error: "mail_rate_limited" }))).toMatchObject({ reason: "rate_limited", retryable: true, retryAfterMs: 120_000 });
    expect(mapInkboxError(new InkboxAPIError(503, { error: "hosted_agent_at_capacity" }))).toMatchObject({ reason: "provider_error", retryable: true });
    expect(mapInkboxError(new InkboxAPIError(403, { error: "recipient_blocked" }))).toMatchObject({ reason: "invalid_address", retryable: false });
    expect(mapInkboxError(new InkboxAPIError(400, { error: "recipient_opted_out" }))).toMatchObject({ reason: "opted_out", retryable: false });
    expect(mapInkboxError(new InkboxAPIError(500, "boom"))).toMatchObject({ reason: "provider_error", retryable: true });
  });
});

describe("inkboxSenderTrust", () => {
  const seller = "harbor@inkboxmail.test";
  it("trusts an Inkbox identity whose own mailbox sent that exact Message-ID", async () => {
    const api = new FakeInkbox();
    const d = api.reply(seller, "<m_1@inkbox.test>", "hi");
    const v = await inkboxSenderTrust(api, { data: { agent_identities: [{ bucket: "from", address: seller }] } as never }, d);
    expect(v).toMatchObject({ trusted: true, address: seller });
  });
  it("never trusts outside senders, unmatched identities, or a key that can't see the mailbox; API outages are retryable", async () => {
    const api = new FakeInkbox();
    const ext = api.reply("quickcater@sellers.example", "<m_1@inkbox.test>", fixture("06-scam-payment-link").text);
    expect(await inkboxSenderTrust(api, { data: { agent_identities: [] } as never }, ext)).toMatchObject({ trusted: false, retryable: false, reason: "unverified-external-sender" });
    const spoof = api.reply(seller, "<m_1@inkbox.test>", "spoofed", [], { recordOutbound: false });
    expect(await inkboxSenderTrust(api, { data: { agent_identities: [{ bucket: "from", address: seller }] } as never }, spoof)).toMatchObject({ trusted: false, reason: "sender-not-verifiable" });
    api.listError = new InkboxAPIError(403, "forbidden");
    expect(await inkboxSenderTrust(api, { data: { agent_identities: [{ bucket: "from", address: seller }] } as never }, spoof)).toMatchObject({ trusted: false, retryable: false });
    api.listError = new InkboxAPIError(502, "bad gateway");
    expect(await inkboxSenderTrust(api, { data: { agent_identities: [{ bucket: "from", address: seller }] } as never }, spoof)).toMatchObject({ trusted: false, retryable: true });
  });
});

describe("Inkbox email loop through the engine", () => {
  it("RFQ out → signed reply webhook → PDF via signed URL → quote; outside sender never quotes; redelivery is deduped", async () => {
    const api = new FakeInkbox();
    const pdf = readFileSync(new URL("attachments/golden-gate-quote-hidden-deposit.pdf", FIX));
    const fetchFake = (async (url: string) => {
      expect(url).toMatch(/^https:\/\/files\.inkbox\.test\//);
      return new Response(pdf, { status: 200 });
    }) as unknown as typeof fetch;
    const seen: { body: string; pdfs: number }[] = [];
    const extractor = {
      async extract(i: { bodyText: string; pdfs: unknown[] }): Promise<QuoteExtraction> {
        seen.push({ body: i.bodyText, pdfs: i.pdfs.length });
        return {
          available: true, price_per_head_usd: null, headcount: 40, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true,
          total_usd: 1016, deposit_usd: 304.8, menu_items: ["lunch"], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }], valid_until: "2026-10-19", questions: [],
          payment_request: "none", instructions_to_agent: false, sources: [{ field: "total", source: "pdf p.1", excerpt: "Total $1,016" }, { field: "deposit", source: "pdf p.2", excerpt: "30% deposit $304.80" }], missing_fields: [], confidence: 0.9,
        };
      },
    };
    const repo = new InMemoryRepository();
    const engine = new HaggleEngine({
      repo, email: inkboxEmail(api, BUYER), extractor, attachments: inkboxAttachments(api, BUYER, fetchFake), brain: new StubBrain(),
      payer: { client: {} as never, signer: null, simulated: false },
      config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: BUYER, collectionWindowMs: 600_000, negotiationWindowMs: 300_000, approvalTtlMs: 1_800_000, globalPaymentCapCents: 500, maxRounds: 2 },
    });
    const seller = "goldengate@inkboxmail.test";
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Golden Gate Kitchen", email: seller }, { name: "QuickCater", email: "quickcater@sellers.example" }], client_request_id: "inkbox-1" });
    expect(deal).toMatchObject({ mode: "live", inbox: BUYER, state: "collecting" });
    expect(api.sent.map((s) => s.o.to[0])).toEqual([seller, "quickcater@sellers.example"]);
    expect(api.sent[0]!.o.subject).toMatch(/^\[HG-[A-Z0-9]{4}\] /);
    expect(api.sent[0]!.o.attachments![0]!.filename).toBe("rfq.json");
    // Retrying deal() with the same client_request_id sends nothing new.
    await engine.deal({ request, budget_usd, businesses: [{ name: "Golden Gate Kitchen", email: seller }], client_request_id: "inkbox-1" });
    expect(api.sent).toHaveLength(2);

    const rfqId = (await repo.getBusinesses(deal.job_id)).find((b) => b.email === seller)!.rfq_message_id!;
    const f04 = fixture("04-hidden-pdf-deposit");
    const detail = api.reply(seller, rfqId, f04.text, [{ filename: f04.attachments[0]!.filename, content_type: "application/pdf", size: pdf.byteLength }]);
    const payload = { id: "evt_r1", event_type: "message.received", data: { message: { id: detail.id }, agent_identities: [{ bucket: "from", address: seller }] } };
    const raw = JSON.stringify(payload);
    const v = verifyInkboxWebhook(raw, signed(raw), SECRET);
    expect(v.ok).toBe(true);
    const msg = inkboxToInbound(payload, await api.get(BUYER, detail.id));
    const trust = await inkboxSenderTrust(api, payload as never, detail);
    expect((await engine.ingest(msg, trustForSender(trust, msg.from))).outcome).toBe("stored");
    expect((await engine.ingest(msg, trustForSender(trust, msg.from))).outcome).toBe("duplicate");

    const ext = api.reply("quickcater@sellers.example", (await repo.getBusinesses(deal.job_id)).find((b) => b.email !== seller)!.rfq_message_id!, fixture("06-scam-payment-link").text);
    const extPayload = { id: "evt_r2", event_type: "message.received", data: { message: { id: ext.id }, agent_identities: [] } };
    const extMsg = inkboxToInbound(extPayload, ext);
    expect((await engine.ingest(extMsg, trustForSender(await inkboxSenderTrust(api, extPayload as never, ext), extMsg.from))).outcome).toBe("stored");

    const board = await engine.getQuotes(deal.job_id);
    expect(seen).toEqual([{ body: f04.text, pdfs: 1 }]); // the scam email was never even sent to the extractor
    expect(board.quotes).toHaveLength(1);
    expect(board.quotes[0]).toMatchObject({ business: "Golden Gate Kitchen", total_usd: 1016, deposit_usd: 304.8, channel: "email", verdict: "compliant" });
    expect(board.quotes[0]!.evidence.deposit_usd).toMatchObject({ source: "pdf p.2" });
    expect(board.businesses.find((b) => b.name === "QuickCater")!.last_event).toMatch(/unverified sender/);
  });

  it("maps a call.ended event to ingestCall input", () => {
    expect(inkboxCallEnded({ data: { call: { id: "call_1", ended_at: "2026-10-17T20:00:00Z" }, outcome: "completed", transcript: { entries: [{ party: "agent", text: "Hi, I'm an AI assistant" }, { party: "remote", text: "$1,070 total" }] } } }))
      .toEqual({ callId: "call_1", outcome: "completed", transcript: "agent: Hi, I'm an AI assistant\nremote: $1,070 total", endedAt: "2026-10-17T20:00:00Z" });
    expect(inkboxCallEnded({ data: {} })).toBeNull();
  });
});
