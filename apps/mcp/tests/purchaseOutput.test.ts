// Workstream D: get_quotes / deal output carries the purchase honestly without changing the shared
// view schemas: compliance per quote, best_available (never a recommendation), and the manual
// purchase stage with untrusted vendor text. Real engine, in-memory store, fake ports; simulated.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, type ExtractorPort } from "@haggle/engine";
import { DealBoard } from "@haggle/core";
import { toDealBoardPlus } from "../src/views.ts";

const APPROVER = "+14155550101";
const trusted = (expected: string) => ({ trusted: true as const, address: expected, reason: "trusted" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });
const extractor: ExtractorPort = {
  async extract(i) {
    const total = Number(/\$([\d,]+) total/.exec(i.bodyText)?.[1]?.replace(/,/g, "") ?? NaN);
    const veg = Number(/(\d+) vegetarian/.exec(i.bodyText)?.[1] ?? NaN);
    return {
      available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true,
      total_usd: Number.isNaN(total) ? null : total, deposit_usd: 200, menu_items: [], dietary_coverage: Number.isNaN(veg) ? [] : [{ need: "vegetarian", covered: true, count_offered: veg }], valid_until: null,
      questions: [], payment_request: "none", instructions_to_agent: false, sources: [{ field: "total", source: "email body", excerpt: "total" }, { field: "deposit", source: "email body", excerpt: "$200 deposit" }], missing_fields: [], confidence: 0.9,
    } as never;
  },
};

describe("deal board output (SIMULATED vendors, manual handoff)", () => {
  it("compliance and best_available reach the agent; the purchase stage never says paid; the core DealBoard still parses", async () => {
    const emails: { to: string; bodyText: string }[] = [];
    const repo = new InMemoryRepository();
    const engine = new HaggleEngine({
      repo, extractor, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
      email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${emails.length}@h.test>` }; } },
      sms: { async send() { return { messageId: "s" }; } },
      config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 600_000, approvalTtlMs: 1_800_000, globalPaymentCapCents: 500_000, maxRounds: 1, notifyPhone: APPROVER, manualPaymentHandoff: true },
    });
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Harbor", email: "h@inkboxmail.test" }, { name: "Grill", email: "g@inkboxmail.test" }] });
    for (const [n, [to, body]] of [["h@inkboxmail.test", "$1,150 total, 14 vegetarian"], ["g@inkboxmail.test", "$900 total, 6 vegetarian"]].entries()) {
      const rfq = (await repo.getBusinesses(deal.job_id)).find((b) => b.email === to)!.rfq_message_id!;
      await engine.ingest({ providerEventId: `e${n}`, eventType: "message.received", providerEmailId: `in${n}`, threadId: `t${n}`, messageId: `<in${n}@x>`, inReplyTo: [rfq], references: [rfq], from: to!, to: ["haggle@inkboxmail.test"], subject: "Re", bodyText: body!, attachments: [], attachmentsDownloadUrl: null }, trusted);
    }
    await engine.advanceJob(deal.job_id);
    let board = await engine.getQuotes(deal.job_id);
    let out = toDealBoardPlus(board, "live");
    const grill = board.quotes.find((q) => q.business === "Grill")!;
    const harbor = board.quotes.find((q) => q.business === "Harbor")!;
    expect(out.compliance![grill.quote_id]).toMatchObject({ status: "noncompliant" });
    expect(out.recommended_quote_id).toBe(harbor.quote_id);
    expect(() => DealBoard.parse(out)).not.toThrow();

    const a = await engine.requestApproval(deal.job_id, harbor.quote_id, "imessage");
    await engine.ingestText({ messageId: "y", from: APPROVER, text: `YES ${a.code}`, inbound: true });
    board = await engine.getQuotes(deal.job_id);
    out = toDealBoardPlus(board, "live");
    expect(out.purchase).toMatchObject({ stage: "awaiting_vendor_confirmation", booked: false, money_verified: false });
    expect(out.payment).toMatchObject({ status: "awaiting_vendor_confirmation" });
    expect(out.next).toMatch(/not to pay/);
    expect(() => DealBoard.parse(out)).not.toThrow();
  });
});
