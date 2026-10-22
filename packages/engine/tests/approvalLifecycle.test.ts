// Approval and payment lifecycle edge cases on the mock engine (simulated fleet + simulated Stripe):
// an approval that lapses after the human's yes, a later approval never charged without pay(),
// and a refused payment that doesn't flood the event log.
import { describe, expect, it } from "vitest";
import { createMockEngine, disabledPayer, fleetBusinesses, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain } from "../src/index.ts";

/** Reads "$X total" and "$Y deposit" from the text when stated; a courtesy note states nothing. */
const textExtractor = { async extract(i: { bodyText: string }) {
  const money = (re: RegExp) => { const m = re.exec(i.bodyText); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
  const total = money(/\$([\d,]+) total/);
  const deposit = money(/\$([\d,]+) deposit/);
  return { available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: total !== null ? true : null, tax_usd: null, tax_included: total !== null ? true : null, total_usd: total, deposit_usd: deposit,
    menu_items: [], dietary_coverage: [], valid_until: null, questions: [], payment_request: "none" as const, instructions_to_agent: false,
    sources: [...(total !== null ? [{ field: "total" as const, source: "text", excerpt: `$${total} total` }] : []), ...(deposit !== null ? [{ field: "deposit" as const, source: "text", excerpt: `$${deposit} deposit` }] : [])],
    missing_fields: total === null ? ["total" as const] : [], confidence: 0.9 };
} };

async function textVendorQuoted() {
  const repo = new InMemoryRepository();
  const e = new HaggleEngine({
    repo, extractor: textExtractor as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send() { return { providerId: "em", status: "sent", idempotentReplay: false, messageId: "<em@x>" }; } },
    imessage: { async send() { return { messageId: "im" }; } },
    config: { mode: "live", inboxDomain: "x.test", sharedInbox: "haggle@x.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 1 },
  });
  const deal = await e.deal({ request: { what: "office deep clean", quantity: 1, unit: "job", date: "2026-11-05", area: "Oakland, CA", requirements: [] }, budget_usd: 3000, businesses: [{ name: "Sparkle Co", phone: "+14155550191", channel: "imessage" }] });
  await e.ingestIMessage({ messageId: "im1", from: "+14155550191", text: "$2,000 total, $400 deposit, supplies included", isGroup: false });
  await e.advanceJob(deal.job_id);
  return { e, repo, deal };
}

async function quotesIn() {
  let t = Date.parse("2026-10-17T19:00:00Z");
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const m = createMockEngine({ now: clock.now });
  const { budget_usd, ...request } = GOLDEN_REQUEST as typeof GOLDEN_REQUEST & { budget_usd: number };
  const deal = await m.engine.deal({ request, budget_usd, businesses: fleetBusinesses().map((b) => ({ name: b.name, ...(b.email ? { email: b.email } : {}), ...(b.phone ? { phone: b.phone } : {}), simulated: true })) } as never);
  for (let i = 0; i < 200; i++) {
    clock.advance(1_000);
    await m.engine.waitForUpdate(deal.job_id, 0, 0);
    const q = await m.engine.getQuotes(deal.job_id);
    for (const pq of q.pending_questions) await m.engine.answerSeller(deal.job_id, pq.question_id, "Yes, plates for 40.");
    if (q.ready) {
      const bay = q.quotes.find((x) => x.business === "Bay Catering")!;
      return { ...m, clock, deal, bay };
    }
  }
  throw new Error("quotes never became final");
}

const charges = (stripe: unknown) => (stripe as { charges: unknown[] }).charges.length;

describe("approval lifecycle", () => {
  it("an approval that lapses after the human's yes, before any charge, returns the deal to choosing", async () => {
    const { engine, clock, deal, bay, repo } = await quotesIn();
    const a = await engine.requestApproval(deal.job_id, bay.quote_id, "simulated");
    await engine.decideApproval(a.id, "approve", "simulated", "DEMO human");
    expect((await repo.getJob(deal.job_id))!.state).toBe("paying");
    clock.advance(31 * 60_000);
    await engine.advanceJob(deal.job_id);
    expect((await repo.getApproval(a.id))!.status).toBe("expired");
    expect((await repo.getJob(deal.job_id))!.state).not.toBe("paying");
    // The human can approve again.
    const again = await engine.requestApproval(deal.job_id, bay.quote_id, "simulated");
    expect(again.status).toBe("pending");
  });

  it("a later approval is never charged until pay is called for it", async () => {
    const { engine, clock, deal, bay, repo, stripe } = await quotesIn();
    const a = await engine.requestApproval(deal.job_id, bay.quote_id, "simulated");
    await engine.decideApproval(a.id, "approve", "simulated", "DEMO human");
    clock.advance(31 * 60_000);
    await expect(engine.pay(deal.job_id, bay.quote_id)).rejects.toThrow();
    await engine.revokeApproval(deal.job_id, a.id, "stale").catch(() => undefined);
    const a2 = await engine.requestApproval(deal.job_id, bay.quote_id, "simulated");
    await engine.decideApproval(a2.id, "approve", "simulated", "DEMO human");
    clock.advance(2_000);
    await engine.advanceJob(deal.job_id);
    expect(charges(stripe)).toBe(0);
    expect((await repo.getJob(deal.job_id))!.state).toBe("paying");
    await engine.pay(deal.job_id, bay.quote_id);
    expect(charges(stripe)).toBe(1);
  });

  it("a courtesy reply after approval states nothing new: the quote and the approval stand", async () => {
    const { e, repo, deal } = await textVendorQuoted();
    const q = (await e.getQuotes(deal.job_id)).quotes[0]!;
    const a = await e.requestApproval(deal.job_id, q.quote_id, "view");
    await e.decideApproval(a.id, "approve", "imessage", "human");
    await e.ingestIMessage({ messageId: "im2", from: "+14155550191", text: "Thanks so much, looking forward to it!", isGroup: false });
    await e.advanceJob(deal.job_id);
    expect((await repo.getApproval(a.id))!.status).toBe("approved");
    expect((await repo.getJob(deal.job_id))!.state).toBe("paying");
    expect((await repo.listQuotes(deal.job_id)).filter((x) => x.status === "current").map((x) => x.id)).toEqual([q.quote_id]);
  });

  it("an earlier deposit is never carried onto a new total smaller than it", async () => {
    const { e, repo, deal } = await textVendorQuoted();
    await e.ingestIMessage({ messageId: "im2", from: "+14155550191", text: "Correction: $300 total, firm.", isGroup: false });
    await e.advanceJob(deal.job_id);
    const current = (await repo.listQuotes(deal.job_id)).find((x) => x.status === "current")!;
    expect(current.total_cents).toBe(30_000);
    expect(current.deposit_cents).toBeNull();
  });

  it("a refused payment is logged once, not on every poll", async () => {
    const { engine, clock, deal, bay, repo } = await quotesIn();
    const a = await engine.requestApproval(deal.job_id, bay.quote_id, "simulated");
    await engine.decideApproval(a.id, "approve", "simulated", "DEMO human");
    // A guard refusal while still paying: the job's payment ceiling is now below the approved amount.
    await repo.touchJob(deal.job_id, { payment_cap_cents: a.payment_cents - 1 });
    await engine.pay(deal.job_id, bay.quote_id).catch(() => undefined);
    for (let i = 0; i < 3; i++) {
      clock.advance(2_000);
      await engine.advanceJob(deal.job_id);
    }
    const refused = (await repo.listEvents(deal.job_id)).filter((e) => e.type === "payment_refused");
    expect(refused).toHaveLength(1);
  });
});
