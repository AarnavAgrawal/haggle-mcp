// Delivery status of Haggle's own outbound email (inbound/deliveryStatus.ts): Inkbox message.bounced
// / message.failed and the reconciler's outbound status sweep. Real engine, FakeInkbox; no network.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InboundReconciler, inkboxEmail, InMemoryRepository, StubBrain } from "../src/index.ts";
import { BUYER, FakeInkbox } from "./helpers/fakeInkbox.ts";

const VENDOR = "orders@realcaterer.example";
const OTHER = "hello@othercaterer.example";
const { budget_usd, ...request } = GOLDEN_REQUEST;

async function setup() {
  const api = new FakeInkbox();
  const repo = new InMemoryRepository();
  const logs: string[] = [];
  const engine = new HaggleEngine({
    repo, email: inkboxEmail(api, BUYER), extractor: { extract: async () => { throw new Error("not used"); } }, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    log: (e) => { logs.push(e); },
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: BUYER, collectionWindowMs: 600_000, negotiationWindowMs: 300_000, approvalTtlMs: 1_800_000, globalPaymentCapCents: 500_000, maxRounds: 1 },
  });
  const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Real Caterer", email: VENDOR }, { name: "Other Caterer", email: OTHER }] });
  const rows = (await repo.listMessages(deal.job_id)).filter((m) => m.direction === "out" && m.kind === "rfq");
  const rfq = (to: string) => rows.find((m) => m.to_address === to)!;
  const biz = async (email: string) => (await repo.getBusinesses(deal.job_id)).find((b) => b.email === email)!;
  const events = async () => (await repo.listEvents(deal.job_id)).filter((e) => e.data.delivery_status);
  return { api, repo, engine, deal, rfq, biz, events, logs };
}

describe("ingestDeliveryStatus", () => {
  it("bounced: our RFQ's address is suppressed (with evidence) and the business marked bounced, exactly once", async () => {
    const { engine, repo, rfq, biz, events } = await setup();
    const r = await engine.ingestDeliveryStatus({ providerMessageId: rfq(VENDOR).provider_email_id!, status: "bounced", source: "webhook" });
    expect(r.outcome).toBe("bounced");
    expect((await biz(VENDOR)).status).toBe("bounced");
    expect(await repo.findSuppressions([VENDOR])).toEqual([expect.objectContaining({ contact: VENDOR, reason: "bounce", evidence: expect.stringContaining("inkbox message.bounced; bounce type not exposed") })]);
    expect((await biz(OTHER)).status).toBe("contacted");
    // The same bounce again (webhook redelivery, then the sweep, by RFC id): no second event.
    expect((await engine.ingestDeliveryStatus({ providerMessageId: rfq(VENDOR).provider_email_id!, status: "bounced", source: "webhook" })).outcome).toBe("duplicate");
    expect((await engine.ingestDeliveryStatus({ providerMessageId: "unknown", rfcMessageId: rfq(VENDOR).rfc_message_id, status: "bounced", source: "reconcile" })).outcome).toBe("duplicate");
    expect(await events()).toHaveLength(1);
    // The suppression holds for later deals.
    await expect(engine.deal({ request, budget_usd, businesses: [{ name: "Real Caterer", email: VENDOR }] })).rejects.toThrow();
  });

  it("failed: recorded as an event, never suppressed, status unchanged", async () => {
    const { engine, repo, rfq, biz, events } = await setup();
    expect((await engine.ingestDeliveryStatus({ providerMessageId: rfq(VENDOR).provider_email_id!, status: "failed", source: "webhook" })).outcome).toBe("delivery_failed");
    expect((await engine.ingestDeliveryStatus({ providerMessageId: rfq(VENDOR).provider_email_id!, status: "failed", source: "reconcile" })).outcome).toBe("duplicate");
    expect(await repo.findSuppressions([VENDOR])).toEqual([]);
    expect((await biz(VENDOR)).status).toBe("contacted");
    expect((await events()).map((e) => e.data.summary)).toEqual([expect.stringMatching(/failed to send/)]);
  });

  it("only our own outbound email counts: an unknown id, an inbound message or a call id changes nothing", async () => {
    const { engine, repo, deal, events } = await setup();
    expect((await engine.ingestDeliveryStatus({ providerMessageId: "m_999", rfcMessageId: "<forged@x>", status: "bounced", source: "webhook" })).outcome).toBe("unmatched");
    await repo.insertMessage({
      job_id: deal.job_id, business_id: null, approval_id: null, direction: "in", kind: "reply", provider_email_id: "in_77", idempotency_key: null, rfc_message_id: "<in77@x>", thread_id: null,
      from_address: VENDOR, to_address: BUYER, subject: null, body_text: "hi", attachments: [], attachments_download_url: null, sender_trusted: false, trust_reason: null, matched_via: null, parse_status: "none", quarantine_reason: null, round: null, simulated: false,
    });
    expect((await engine.ingestDeliveryStatus({ providerMessageId: "in_77", status: "bounced", source: "webhook" })).outcome).toBe("unmatched");
    expect(await repo.findSuppressions([VENDOR, OTHER])).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it("a bounce after the business replied from that address is recorded, not suppressed (Inkbox doesn't say permanent or transient)", async () => {
    const { engine, repo, deal, rfq, biz } = await setup();
    await repo.updateBusiness(deal.job_id, (await biz(VENDOR)).business_id, { status: "quoted", last_reply_at: new Date().toISOString() });
    expect((await engine.ingestDeliveryStatus({ providerMessageId: rfq(VENDOR).provider_email_id!, status: "bounced", source: "webhook" })).outcome).toBe("bounce_recorded");
    expect(await repo.findSuppressions([VENDOR])).toEqual([]);
    expect((await biz(VENDOR)).status).toBe("quoted");
  });
});

describe("reconciler: outbound status sweep", () => {
  it("picks up bounced/failed outbound mail from the buyer mailbox once; ignores delivered, inbound and other mailboxes", async () => {
    const { api, engine, repo, rfq, biz } = await setup();
    const logs: string[] = [];
    const reconciler = new InboundReconciler({ engine, repo, log: (e) => { logs.push(e); }, sources: { mail: { api, buyerMailbox: BUYER, senderTrust: { policy: "outbound-verified" }, identityAddresses: async () => [BUYER] } } });
    api.messages.get(rfq(VENDOR).provider_email_id!)!.status = "bounced";
    api.messages.get(rfq(OTHER).provider_email_id!)!.status = "delivered";
    api.messages.set("x_1", { id: "x_1", mailbox: "someone-else@inkboxmail.test", direction: "outbound", status: "bounced", threadId: null, messageId: "<x1@x>", fromAddress: "someone-else@inkboxmail.test", toAddresses: [OTHER], subject: null, bodyText: null, inReplyTo: null, references: null, attachmentMetadata: null });
    const first = await reconciler.sweepAll();
    expect(first.recovered).toEqual([expect.objectContaining({ channel: "email", providerId: rfq(VENDOR).provider_email_id, outcome: "bounced" })]);
    expect((await biz(VENDOR)).status).toBe("bounced");
    expect((await biz(OTHER)).status).toBe("contacted");
    expect(await repo.findSuppressions([OTHER])).toEqual([]);
    expect((await reconciler.sweepAll()).recovered).toEqual([]);
  });
});
