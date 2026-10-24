// Sprint 4 integration: the board's `vendor_contact` (the slot apps/mcp/src/views.ts passes through)
// lists businesses whose contact needs explaining (opted out, bounced, failed, held reply, deferred),
// from inbound/contactStatus.ts. Real engine, in-memory store, fake ports.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain } from "../src/index.ts";
import type { TrustVerdict } from "../src/inbound/primitive.ts";

const noEvidence = { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] };
const trusted = (e: string): TrustVerdict => ({ trusted: true, address: e, reason: "trusted", evidence: noEvidence });
const { budget_usd, ...request } = GOLDEN_REQUEST;

function setup() {
  const repo = new InMemoryRepository();
  let n = 0;
  const engine = new HaggleEngine({
    repo, now: () => new Date(), extractor: { async extract() { throw new Error("not used"); } } as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send(m) { n++; return { providerId: `em_${n}`, status: "sent", idempotentReplay: false, messageId: `<m${n}@x.test>` }; } },
    sms: { async send() { return { messageId: "s" }; } },
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 1, notifyPhone: "+14155550101" },
  });
  return { engine, repo };
}

describe("board vendor_contact", () => {
  it("an opted-out business is listed with its status; a contacted, silent one isn't", async () => {
    const { engine, repo } = setup();
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Harbor", email: "harbor@inkboxmail.test" }, { name: "Quiet", email: "quiet@inkboxmail.test" }] });
    const [harbor, quiet] = await repo.getBusinesses(deal.job_id);
    const out = await engine.ingest({ providerEventId: "e1", eventType: "message.received", providerEmailId: "in1", threadId: "t1", messageId: "<in1@x>", inReplyTo: [harbor!.rfq_message_id!], references: [harbor!.rfq_message_id!], from: "harbor@inkboxmail.test", to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText: "Please remove me from your list.", attachments: [], attachmentsDownloadUrl: null }, trusted);
    expect(out.outcome).toBe("opted_out");
    const board = (await engine.getQuotes(deal.job_id)) as { vendor_contact?: Record<string, { status: string; detail: string }> };
    expect(board.vendor_contact?.[harbor!.business_id]).toMatchObject({ status: "opted_out" });
    expect(board.vendor_contact?.[quiet!.business_id]).toBeUndefined();
  });
});
