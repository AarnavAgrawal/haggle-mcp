// Quote integrity across revisions, approval correctness and budget semantics. Real engine, fake
// Inkbox ports, an extractor that reads only what each text says. No network.
// Live regression: job_dec51a570667400eae64 (2026-10-18), Sunset Kitchen by RCS.
import { describe, expect, it } from "vitest";
import { disabledPayer, HaggleEngine, InMemoryRepository, simulatedStripe, StubBrain } from "../src/index.ts";

const extractor = {
  async extract(i: { bodyText: string }) {
    // Only the business's own words: a text reply carries Haggle's last text as context (never its figures).
    const t = i.bodyText.replace(/^\[Haggle's last text[^\n]*\n\[The business's reply\]: /, "");
    const k = (s: string) => Math.round(Number(s.replace(/[,$]/g, "").replace(/k$/i, "")) * (/k$/i.test(s) ? 1000 : 1));
    const total = /\$([\d.,]+k?)\s*total/i.exec(t)?.[1];
    const deposit = /\$([\d.,]+k?)\s*deposit/i.exec(t)?.[1];
    const fee = /\$?([\d.,]+)\s*extra for delivery/i.exec(t)?.[1];
    const veg = /(\d+)\s*veg/i.exec(t)?.[1];
    const sources = [
      ...(total ? [{ field: "total" as const, source: "text", excerpt: `$${total} total` }] : []),
      ...(deposit ? [{ field: "deposit" as const, source: "text", excerpt: `$${deposit} deposit` }] : []),
      ...(fee ? [{ field: "delivery_fee" as const, source: "text", excerpt: `$${fee} extra for delivery` }] : []),
    ];
    return {
      available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: fee ? k(fee) : null, delivery_included: fee ? false : /delivery included/i.test(t) ? true : null,
      tax_usd: null, tax_included: null, total_usd: total ? k(total) : null, deposit_usd: deposit ? k(deposit) : null, menu_items: [],
      dietary_coverage: veg ? [{ need: "vegetarian", covered: true, count_offered: Number(veg) }] : [], valid_until: null, questions: [], payment_request: "none" as const, instructions_to_agent: false,
      ...(fee ? { requirement_answers: [{ requirement: "Total must include delivery and all fees", answer: "no" as const, excerpt: `$${fee} extra for delivery` }] } : {}),
      ...(/\$(\d+) staffing, not included/.test(t) ? { other_fees: [{ label: "staffing", amount_usd: Number(/\$(\d+) staffing/.exec(t)![1]), included_in_total: false, excerpt: /\$\d+ staffing, not included/.exec(t)![0] }] } : {}),
      sources, missing_fields: [], confidence: 0.9,
    };
  },
};

function engine(opts: { stripe?: boolean } = {}) {
  let t = Date.now();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const texts: { to: string; text: string }[] = [];
  const sent: { to: string; bodyText: string }[] = [];
  const repo = new InMemoryRepository();
  const stripe = simulatedStripe();
  const e = new HaggleEngine({
    repo, now: clock.now, extractor: extractor as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("Payments are off"),
    ...(opts.stripe ? { stripe } : {}),
    email: { async send(m) { sent.push(m); return { providerId: `em_${sent.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${sent.length}@haggle.test>` }; } },
    imessage: { async send(r) { texts.push(r); return { messageId: `im_${texts.length}` }; } },
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 3 },
  });
  return { engine: e, repo, clock, texts, sent, stripe };
}

const REQUEST = { what: "lunch catering", quantity: 200, unit: "people", date: "2026-10-24", area: "San Francisco, CA", requirements: [{ id: "veg40", kind: "dietary" as const, text: "At least 40 vegetarian meals", hard: true, need: "vegetarian", min_count: 40 }] };
// The live deal also asked for an all-in total (a general requirement the business answers in words).
const LIVE_REQUEST = { ...REQUEST, requirements: [...REQUEST.requirements, { id: "allin", kind: "other" as const, text: "Total must include delivery and all fees", hard: true }] };
const SUNSET = { name: "Sunset Kitchen", phone: "+14155550111", channel: "imessage" as const };
const text = (e: HaggleEngine, id: string, body: string) => e.ingestIMessage({ messageId: id, from: SUNSET.phone, text: body, isGroup: false });

describe("quote revisions and approvals", () => {
  it("the live Sunset Kitchen sequence: $4.5k (all-in unknown → not approvable, one confirming text), then '$250 extra for delivery' → $4,750; a later revision voids that approval", async () => {
    const { engine: e, stripe, texts } = engine({ stripe: true });
    const deal = await e.deal({ request: LIVE_REQUEST, budget_usd: 5000, businesses: [SUNSET] });
    await text(e, "im_1", "$4.5k total, $1k deposit");
    await e.advanceJob(deal.job_id);
    let board = await e.getQuotes(deal.job_id);
    const v1 = board.quotes.find((q) => q.status === "current")!;
    // Unknown all-in total: still ranked (soft, decision 1) but not approvable (decision 19).
    expect(v1).toMatchObject({ total_usd: 4500, deposit_usd: 1000, approvable: false });
    expect(board.recommended_quote_id).toBeUndefined(); // never recommended before the all-in total is known
    expect(texts.at(-1)!.text).toMatch(/^Thanks! Can you confirm: At least 40 vegetarian meals; Total must include delivery and all fees; the all-in total including delivery, tax and any fees\? HG-/);
    await expect(e.requestApproval(deal.job_id, v1.quote_id, "view")).rejects.toBeTruthy(); // the live mistake can't happen any more

    await text(e, "im_2", "yes 40 veggie meals . $250 extra for delivery");
    await e.advanceJob(deal.job_id);
    board = await e.getQuotes(deal.job_id);
    const v2 = board.quotes.find((q) => q.status === "current")!;
    expect(v2).toMatchObject({ total_usd: 4750, deposit_usd: 1000, delivery_usd: 250, round: 1, negotiated_from: 4500, meets_requirements: true, eligible: true }); // still round 1: a confirm-once revision, not a counter answer (decision 16)
    expect(v2.source).toMatch(/^computed from stated total \+ delivery fee/);
    expect(board.recommended_quote_id).toBe(v2.quote_id);
    const a = await e.requestApproval(deal.job_id, v2.quote_id, "view");
    expect(a).toMatchObject({ quote_total_cents: 475_000, payment_cents: 100_000 });
    expect(await e.decideApproval(a.id, "approve", "imessage", "human")).toBe(true);

    // After approval the business changes its price: that approval is void, the job reopens, nothing is charged on it.
    await text(e, "im_3", "Correction: $4.9k total, $1k deposit, 40 veg, delivery included");
    await e.advanceJob(deal.job_id);
    board = await e.getQuotes(deal.job_id);
    const v3 = board.quotes.find((q) => q.status === "current")!;
    expect(v3).toMatchObject({ total_usd: 4900, round: 1 }); // versions before any counter stay round 1 (decision 16)
    expect(board.approval).toMatchObject({ approval_id: a.id, status: "expired" });
    expect(board.state).not.toBe("paying");
    await expect(e.pay(deal.job_id, v2.quote_id)).rejects.toBeTruthy();
    expect(stripe.charges).toHaveLength(0);
    // Fresh, explicit consent to the current version pays exactly its deposit, once.
    const a3 = await e.requestApproval(deal.job_id, v3.quote_id, "view");
    await e.decideApproval(a3.id, "approve", "imessage", "human");
    expect(await e.pay(deal.job_id, v3.quote_id)).toMatchObject({ status: "settled", amount_usd: 1000 });
    expect(await e.pay(deal.job_id, v3.quote_id)).toMatchObject({ status: "settled", amount_usd: 1000 }); // replay: same payment
    expect(stripe.charges).toEqual([expect.objectContaining({ amountCents: 100_000, metadata: expect.objectContaining({ quote_id: v3.quote_id, approval_id: a3.id }) })]);
  });

  it("over a 'limit' budget is soft (decision 33): ranked and approvable with an 'over the limit' caveat; a target budget stays comparable, negotiable and approvable with a caveat", async () => {
    const hard = engine();
    const d1 = await hard.engine.deal({ request: { ...REQUEST, budget_kind: "limit" }, budget_usd: 4000, businesses: [SUNSET] });
    await text(hard.engine, "im_h", "$4.5k total, $1k deposit, 45 veg, delivery included");
    await hard.engine.advanceJob(d1.job_id);
    const q1 = (await hard.engine.getQuotes(d1.job_id)).quotes[0]!;
    expect(q1).toMatchObject({ eligible: true, verdict: "incomplete", approvable: true });
    expect(await hard.engine.approvalCaveats(d1.job_id, q1.quote_id)).toEqual(expect.arrayContaining(["$500 over the $4,000 limit"]));
    expect((await hard.engine.requestApproval(d1.job_id, q1.quote_id, "view")).status).toBe("pending");
    expect(hard.texts.filter((x) => /target/.test(x.text))).toHaveLength(0); // a limit is never used as a negotiating claim

    const soft = engine();
    const d2 = await soft.engine.deal({ request: REQUEST, budget_usd: 4000, businesses: [SUNSET] });
    await text(soft.engine, "im_s", "$4.5k total, $1k deposit, 45 veg, delivery included");
    await soft.engine.advanceJob(d2.job_id);
    const board = await soft.engine.getQuotes(d2.job_id);
    expect(board.quotes[0]).toMatchObject({ eligible: true, total_usd: 4500 });
    expect(board.quotes[0]!.flags).toContain("over_budget");
    expect(await soft.engine.approvalCaveats(d2.job_id, board.quotes[0]!.quote_id)).toEqual(expect.arrayContaining(["$500 over the $4,000 budget"]));
    // Haggle negotiates toward the buyer's target instead of declaring a winner.
    expect(board.state).toBe("negotiating");
    const sid = board.quotes[0]!.business_id;
    expect(board.stages![sid]).toMatchObject({ stage: "countered", negotiation: "countered", first_total_usd: 4500, current_total_usd: 4500 }); // a counter is not a price
    expect(soft.texts.at(-1)!.text).toBe("Thanks! AI assistant for a customer again. Our client's target is $4,000.00 total. Anything you can do to get closer (delivery or deposit)? Ref HG-" + (await soft.repo.getJob(d2.job_id))!.short_code);
    // The business revises: the new price shows as negotiated, with the original kept as history.
    await text(soft.engine, "im_s2", "Best we can do is $4.2k total, $800 deposit, 45 veg, delivery included");
    await soft.engine.advanceJob(d2.job_id);
    const after = await soft.engine.getQuotes(d2.job_id);
    expect(after.quotes.find((q) => q.status === "current")).toMatchObject({ total_usd: 4200, negotiated_from: 4500, deposit_usd: 800, round: 2 });
    expect(after.stages![sid]).toMatchObject({ first_total_usd: 4500, current_total_usd: 4200, quote_version: 2, saved_usd: 300 });
    // $4,200 is still above the target, but jobs have two rounds (the first quotes + one negotiation
    // round; the jobs table stores at most 2): Haggle stops and explains instead of pushing again.
    expect(after.negotiation).toEqual([
      expect.objectContaining({ business: "Sunset Kitchen", round: 2, target_total_usd: 4000, basis_quote_id: "buyer_target", outcome_total_usd: 4200 }),
    ]);
    soft.clock.advance(11 * 60_000);
    const done = await soft.engine.getQuotes(d2.job_id);
    expect(done.ready).toBe(true);
    expect(done.stages![sid]).toMatchObject({ stage: "vendor_revised", negotiation: "vendor_revised", first_total_usd: 4500, current_total_usd: 4200, saved_usd: 300 });
    expect(soft.texts.filter((x) => /target/.test(x.text))).toHaveLength(1);
  });

  it("an operator can void an approval whose recorded terms were wrong: reason recorded, job reopened, nothing charged", async () => {
    const { engine: e, stripe } = engine({ stripe: true });
    const deal = await e.deal({ request: REQUEST, budget_usd: 5000, businesses: [SUNSET] });
    await text(e, "im_o", "$4.5k total, $1k deposit, 45 veg, delivery included");
    await e.advanceJob(deal.job_id);
    const q = (await e.getQuotes(deal.job_id)).quotes[0]!;
    const a = await e.requestApproval(deal.job_id, q.quote_id, "view");
    await e.decideApproval(a.id, "approve", "imessage", "human");
    expect(await e.revokeApproval(deal.job_id, a.id, "recorded total omitted the $250 delivery the business disclosed")).toBe(true);
    const board = await e.getQuotes(deal.job_id);
    expect(board.approval).toMatchObject({ status: "expired" });
    expect(board.state).not.toBe("paying");
    await expect(e.pay(deal.job_id, q.quote_id)).rejects.toBeTruthy();
    expect(stripe.charges).toHaveLength(0);
    expect(await e.revokeApproval(deal.job_id, a.id, "again")).toBe(false); // once
  });

  it("a clarification that discloses a new excluded fee updates the all-in total and voids an approval of the old version", async () => {
    const { engine: e, stripe } = engine({ stripe: true });
    const deal = await e.deal({ request: REQUEST, budget_usd: 6000, businesses: [SUNSET] });
    await text(e, "im_f1", "$4.5k total, $1k deposit, 45 veg, delivery included");
    await e.advanceJob(deal.job_id);
    const v1 = (await e.getQuotes(deal.job_id)).quotes[0]!;
    const a = await e.requestApproval(deal.job_id, v1.quote_id, "view");
    await e.decideApproval(a.id, "approve", "imessage", "human");
    await text(e, "im_f2", "One thing: $300 staffing, not included");
    await e.advanceJob(deal.job_id);
    const board = await e.getQuotes(deal.job_id);
    const v2 = board.quotes.find((q) => q.status === "current")!;
    expect(v2).toMatchObject({ total_usd: 4800, round: 1 }); // a clarification before any counter stays round 1 (decision 16)
    expect(v2.source).toMatch(/^computed from stated total \+ staffing/);
    expect(board.terms![v2.quote_id]!.fees).toEqual([expect.objectContaining({ label: "staffing", amount_usd: 300, included: false })]);
    expect(board.approval).toMatchObject({ approval_id: a.id, status: "expired" });
    expect(stripe.charges).toHaveLength(0);
  });
});
