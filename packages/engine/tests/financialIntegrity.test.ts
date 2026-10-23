// Financial integrity (2026-10-23): the live Claude eval on the 59-reply corpus found quotes a human could
// approve on wrong money: fx-08 (40 x $26 + $80 delivery = $1,120, "Total: $1,050" approvable at $1,050),
// c44 / c17 ("half up front" / "50% deposit" left unread: "the full total is due up front"), fx-11 and c13
// (the delivery fee read twice, the all-in total wrong or held back). The readings below are hand-written
// in the shape Claude produced; the corpus replies are the repo's own (eval/corpus.ts). Each engine-level
// test runs the real ingest path (cleanEmailBody -> validateQuote -> board -> approval).
import { describe, expect, it } from "vitest";
import { loadCorpus, CORPUS_REQUEST } from "../eval/corpus.ts";
import { observeCase } from "../eval/extraction.ts";
import { layoutReply } from "../eval/clients.ts";
import { BUYER_INBOX, makeEnv, trusted } from "../eval/harness.ts";
import { checkDeposit, dedupeFees, depositShare, reconcileTotal, recordIssues, shareOf, type ReconcileInput } from "../src/parsing/financialIntegrity.ts";
import { validateQuote } from "../src/parsing/validate.ts";
import type { QuoteExtraction } from "../src/parsing/extraction.ts";
import { checkApprovedPayment } from "../src/payments/guard.ts";
import { planCounteroffers, type CounterQuote } from "../src/negotiation/counteroffer.ts";
import { rankQuotes } from "../src/ranking/rank.ts";
import { mergeCarryOver } from "../src/workflow/engine.ts";
import type { ExtractorPort } from "../src/workflow/ports.ts";

const corpus = loadCorpus();
const byId = (id: string) => corpus.find((c) => c.id === id)!;
type Src = QuoteExtraction["sources"][number];
const src = (field: Src["field"], excerpt: string, source = "email body"): Src => ({ field, source, excerpt });

/** A Claude-shaped reading: everything unstated, then the figures a case sets (each with its source). */
function reading(o: Partial<QuoteExtraction> = {}): QuoteExtraction {
  return {
    available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: null, tax_usd: null,
    tax_status: "included", tax_rate_percent: null, tax_evidence: "tax included", total_usd: null, deposit_usd: null, menu_items: [],
    dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }], valid_until: null, questions: [], payment_request: "none", instructions_to_agent: false,
    sources: [], missing_fields: [], confidence: 0.9, other_fees: [], terms: { deposit_terms: null, cancellation: null, exclusions: [] }, ...o,
  };
}
const fixed = (x: QuoteExtraction): ExtractorPort => ({ extract: async () => structuredClone(x) });
const codes = (r: { financial?: { issues: { code: string }[] } }) => (r.financial?.issues ?? []).map((i) => i.code);

// The readings Claude produced on the corpus (live eval, 2026-10-23), reduced to the fields that matter.
const FX08 = reading({
  price_per_head_usd: 26, headcount: 40, subtotal_usd: 1040, delivery_fee_usd: 80, total_usd: 1050,
  sources: [src("price_per_head", "40 lunches x $26.00 = $1,040.00"), src("subtotal", "40 lunches x $26.00 = $1,040.00"), src("delivery_fee", "Delivery: $80.00"), src("total", "Total: $1,050.00 (tax included)")],
});
const C44 = reading({ delivery_included: true, total_usd: 1120, terms: { deposit_terms: "Half up front, balance on the day.", cancellation: null, exclusions: [] }, sources: [src("total", "Total: $1,120 delivered, tax included")] });
const C17 = reading({ delivery_included: true, total_usd: 1240, terms: { deposit_terms: "50% deposit due at booking", cancellation: null, exclusions: [] }, sources: [src("total", "Total: $1,240 delivered, tax included.")] });
const FX11 = reading({
  price_per_head_usd: 22.5, headcount: 40, subtotal_usd: 900, delivery_fee_usd: 60, delivery_included: false, tax_status: "added_on_top", tax_rate_percent: 8.5, tax_evidence: "Sales tax ... added at 8.5% on the food subtotal",
  other_fees: [{ label: "Delivery and setup fee", amount_usd: 60, included_in_total: null, excerpt: "Delivery and setup fee $60.00" }, { label: "Service charge (8%)", amount_usd: 72, included_in_total: null, excerpt: "Service charge (8%) $72.00" }],
  sources: [src("price_per_head", "Boxed lunch 40 x $22.50", "pdf p.1"), src("subtotal", "Boxed lunch 40 x $22.50 $900.00", "pdf p.1"), src("delivery_fee", "Delivery and setup fee $60.00", "pdf p.2")],
});
const C13 = reading({
  subtotal_usd: 1000, delivery_fee_usd: 75, delivery_included: false,
  other_fees: [{ label: "Delivery fee", amount_usd: 75, included_in_total: null, excerpt: "Delivery fee: $75" }],
  sources: [src("subtotal", "Food total: $1,000 (tax included)"), src("delivery_fee", "Delivery fee: $75")],
});
const C40 = reading({
  subtotal_usd: 900, delivery_fee_usd: 50, delivery_included: false, total_usd: 1040,
  other_fees: [{ label: "Service fee (10% of food)", amount_usd: 90, included_in_total: true, excerpt: "Service fee (10% of food): $90" }],
  sources: [src("subtotal", "Food: $900"), src("delivery_fee", "Delivery: $50"), src("total", "Total due: $1,040")],
});
const C41 = reading({ headcount: 40, subtotal_usd: 1050, delivery_included: true, total_usd: 1300, sources: [src("subtotal", "Your 40 lunches come to $1,050"), src("total", "we would bill the $1,300 minimum, delivered and tax included")] });

describe("reconcileTotal: the stated total against the business's own parts (integer cents)", () => {
  const base = (o: Partial<ReconcileInput>): ReconcileInput => ({ stated_total_cents: 105_000, food_cents: 104_000, delivery: { cents: 8_000, included: null }, tax: { kind: "inside_unknown" }, fees: [], ...o });

  it("fx-08: $1,040 food + $80 delivery against a $1,050 total is inconsistent however the delivery fee is placed", () => {
    const r = reconcileTotal(base({}));
    expect(r.verdict).toBe("inconsistent");
    expect(r.expected_cents).toBe(112_000); // the natural reading: every listed charge in the total
  });

  it("parts that add up to the cent are consistent (food + delivery + included fee = total)", () => {
    expect(reconcileTotal(base({ stated_total_cents: 104_000, food_cents: 90_000, delivery: { cents: 5_000, included: false }, fees: [{ label: "Service fee", amount_cents: 9_000, included_in_total: true, excerpt: "" }] }))).toMatchObject({ verdict: "consistent", delivery: "inside", outside_cents: 0 });
  });

  it("a fee the figures put outside the stated total is placed there only when they add up to the cent", () => {
    // $900 food + $60 delivery = the stated $960; the $72 service charge is not in it.
    const r = reconcileTotal(base({ stated_total_cents: 96_000, food_cents: 90_000, delivery: { cents: 6_000, included: false }, tax: { kind: "outside" }, fees: [{ label: "Service charge", amount_cents: 7_200, included_in_total: null, excerpt: "" }] }));
    expect(r).toMatchObject({ verdict: "consistent", delivery: "inside", fees: ["outside"], outside_cents: 7_200 });
  });

  it("unknown is never zero: an unpriced charge or unknown tax absorbs a total ABOVE the parts (a minimum order), never one below", () => {
    expect(reconcileTotal(base({ stated_total_cents: 130_000, food_cents: 105_000, delivery: { cents: null, included: true } })).verdict).not.toBe("inconsistent");
    expect(reconcileTotal(base({ stated_total_cents: 100_000, food_cents: 110_000, delivery: { cents: null, included: true } })).verdict).toBe("inconsistent");
    expect(reconcileTotal(base({ stated_total_cents: 100_000, food_cents: 110_000, delivery: { cents: null, included: null }, fees: [{ label: "Setup", amount_cents: null, included_in_total: null, excerpt: "" }] })).verdict).toBe("inconsistent");
  });

  it("'tax included' fits 0 (tax-inclusive prices) or a real sales-tax share, not a sliver ($10 on $1,040)", () => {
    expect(reconcileTotal(base({ stated_total_cents: 104_000, delivery: { cents: null, included: null } })).verdict).toBe("consistent");
    expect(reconcileTotal(base({ stated_total_cents: 112_970, delivery: { cents: null, included: null } })).verdict).toBe("consistent"); // 8.625%
    expect(reconcileTotal(base({ stated_total_cents: 105_000, delivery: { cents: null, included: null } })).verdict).toBe("inconsistent");
  });

  it("a stated rate must match: $1,000 + 8.625% is $1,086.25, not $1,050", () => {
    const rated = (t: number) => reconcileTotal(base({ stated_total_cents: t, food_cents: 100_000, delivery: { cents: null, included: null }, tax: { kind: "inside_rate", rate_percent: 8.625 } })).verdict;
    expect(rated(108_625)).toBe("consistent");
    expect(rated(105_000)).toBe("inconsistent");
  });

  it("with food unknown, a delivery fee the business didn't place leaves the all-in total unknown ('Total $1,000 plus $75 delivery')", () => {
    expect(reconcileTotal(base({ stated_total_cents: 100_000, food_cents: null, delivery: { cents: 7_500, included: false } })).verdict).toBe("ambiguous");
    // ...unless the business's own words for the total say delivery is in it.
    expect(reconcileTotal(base({ stated_total_cents: 100_000, food_cents: null, delivery: { cents: 7_500, included: false }, total_excerpt: "Total: $1,000 delivered" })).verdict).toBe("unverifiable");
    // Words that mention delivery as extra never place it inside.
    for (const total_excerpt of ["Total $1,000, delivery extra", "Total $1,000 + delivery", "Total $1,000 excluding delivery"]) {
      expect(reconcileTotal(base({ stated_total_cents: 100_000, food_cents: null, delivery: { cents: 7_500, included: false }, total_excerpt })).verdict, total_excerpt).toBe("ambiguous");
    }
  });

  it("a discount inside the total is part of the arithmetic", () => {
    expect(reconcileTotal(base({ stated_total_cents: 90_000, food_cents: 100_000, delivery: { cents: null, included: null }, tax: { kind: "unstated" }, fees: [{ label: "Nonprofit discount", amount_cents: -10_000, included_in_total: true, excerpt: "" }] })).verdict).toBe("consistent");
  });
});

describe("dedupeFees: a charge read twice counts once", () => {
  it("drops an 'other fee' that is the delivery fee or the stated tax, and repeated lines; keeps different charges", () => {
    const fees = [
      { label: "Delivery fee", amount_cents: 7_500, included_in_total: null, excerpt: "" },
      { label: "Sales tax", amount_cents: 8_625, included_in_total: null, excerpt: "" },
      { label: "Setup", amount_cents: 5_000, included_in_total: false, excerpt: "" },
      { label: "setup", amount_cents: 5_000, included_in_total: false, excerpt: "" },
      { label: "Delivery and setup", amount_cents: 9_000, included_in_total: null, excerpt: "" },
    ];
    const r = dedupeFees(fees, 7_500, 8_625);
    expect(r.fees.map((f) => f.label)).toEqual(["Setup", "Delivery and setup"]);
    expect(r.notes).toHaveLength(3);
  });
});

describe("deposits stated as a share", () => {
  it("reads 'half up front', '50% deposit', 'a 25% non-refundable deposit', 'deposit of 30%', 'a third to hold the date'", () => {
    expect(depositShare(["Half up front, balance on the day."])).toMatchObject({ num: 1, den: 2 });
    expect(depositShare(["50% deposit due at booking"])).toMatchObject({ num: 5000, den: 10_000 });
    expect(depositShare(["A 25% non-refundable deposit ($273.75) is due on booking."])).toMatchObject({ num: 2500 });
    expect(depositShare(["Non-refundable deposit of 30% of the total ($304.80) due at booking"])).toMatchObject({ num: 3000 });
    expect(depositShare(["We take a third to hold the date."])).toMatchObject({ num: 1, den: 3 });
  });

  it("never reads a tax, service or menu share as a deposit; 'no deposit' is none; a deposit with no figure is 'mentioned'", () => {
    expect(depositShare(["Plus 8.625% sales tax. 18% service charge."])).toBeNull();
    expect(depositShare(["Half the menu is vegetarian. Deposit: $200."])).toBe("mentioned");
    expect(depositShare(["No deposit required."])).toBe("none");
    expect(depositShare(["A deposit is required to hold the date."])).toBe("mentioned");
    // Two different shares are never guessed between.
    expect(depositShare(["50% deposit at booking.", "We need a 30% deposit."])).toBe("mentioned");
  });

  it("computes the amount in exact cents only from the business's own all-in total; checks a stated amount against a stated share", () => {
    const half = { num: 1, den: 2, phrase: "Half up front" };
    expect(shareOf(112_000, half)).toBe(56_000);
    expect(shareOf(100_000, { num: 1, den: 3, phrase: "a third" })).toBe(33_333);
    expect(checkDeposit({ deposit_cents: null, total_cents: 112_000, stated_total_cents: 112_000, share: half })).toMatchObject({ deposit_cents: 56_000 });
    // Haggle added a fee on top of the stated total: "half" of which? Asked, not guessed.
    expect(checkDeposit({ deposit_cents: null, total_cents: 118_000, stated_total_cents: 100_000, share: half }).issue?.code).toBe("deposit_unquantified");
    expect(checkDeposit({ deposit_cents: 40_000, total_cents: 101_600, stated_total_cents: 101_600, share: { num: 3000, den: 10_000, phrase: "30%" } }).issue?.code).toBe("deposit_mismatch");
    expect(checkDeposit({ deposit_cents: 30_480, total_cents: 101_600, stated_total_cents: 101_600, share: { num: 3000, den: 10_000, phrase: "30%" } }).issue).toBeUndefined();
    expect(checkDeposit({ deposit_cents: 150_000, total_cents: 120_000, stated_total_cents: 120_000, share: null }).issue?.code).toBe("deposit_over_total");
  });
});

describe("validateQuote: the eval failures, as Claude read them", () => {
  it("fx-08: the stated $1,050 is kept (never replaced), flagged and held for the business to clarify", () => {
    const r = validateQuote(FX08, 40);
    expect(r.total_cents).toBe(105_000);
    expect(codes(r)).toEqual(["total_mismatch"]);
    expect(r.financial?.issues[0]?.detail).toBe("the listed charges add up to $1,120.00, but the stated total is $1,050.00");
    expect(r.flags).toContain("conflicting_numbers");
  });

  it("c44 / c17: 'half up front' and '50% deposit due at booking' become $560 and $620, labelled as computed", () => {
    for (const [x, dep] of [[C44, 56_000], [C17, 62_000]] as const) {
      const r = validateQuote(x, 40, [], { text: x.terms!.deposit_terms! });
      expect(r.deposit_cents).toBe(dep);
      expect(r.sources.deposit?.source).toMatch(/^computed: .* of the stated total/);
      expect(codes(r)).toEqual([]);
    }
  });

  it("fx-11: the delivery fee read twice counts once; the service charge is added; all-in $1,108.50 = $900 + $60 + $72 + $76.50", () => {
    const r = validateQuote(FX11, 40);
    expect(r.total_cents).toBe(110_850);
    expect(r.tax_cents).toBe(7_650);
    expect(r.other_fees?.map((f) => [f.label, f.included_in_total])).toEqual([["Service charge (8%)", false]]);
    expect(r.flags).not.toContain("fees_unclear");
    expect(r.sources.total?.source).toMatch(/^computed/);
  });

  it("c13: 'Food total $1,000, Delivery fee $75' is $1,075 once, with no stated total or with Claude's own sum", () => {
    const noTotal = validateQuote(C13, 40);
    expect(noTotal.total_cents).toBe(107_500);
    expect(noTotal.flags).not.toContain("fees_unclear");
    const summed = validateQuote({ ...C13, total_usd: 1075, sources: [...C13.sources, src("total", "Food total: $1,000 (tax included). Delivery fee: $75.")] }, 40);
    expect(summed.total_cents).toBe(107_500);
    expect(codes(summed)).toEqual([]);
  });

  it("no false alarms: c40 (reader said delivery not included; the figures say it is), c41 (minimum order), an all-in per-person price", () => {
    const c40 = validateQuote(C40, 40);
    expect([c40.total_cents, codes(c40), c40.financial?.status]).toEqual([104_000, [], "consistent"]);
    const c41 = validateQuote(C41, 40);
    expect([c41.total_cents, codes(c41)]).toEqual([130_000, []]);
    // quote.json "per_head_usd": 28.75 x 40 = the $1,150 total (fx-01), with $68 tax inside: per person ALL-IN, not food.
    const allIn = validateQuote(reading({ price_per_head_usd: 28.75, headcount: 40, delivery_fee_usd: 0, delivery_included: true, tax_usd: 68, total_usd: 1150, sources: [src("price_per_head", "price_per_head=28.75", "quote.json"), src("delivery_fee", "0", "quote.json"), src("tax", "68", "quote.json"), src("total", "total=1150", "quote.json")] }), 40);
    expect(codes(allIn)).toEqual([]);
  });

  it("quote.json carries the request's headcount, not its own: a per-head price for 40 against a 50-person request is never 'food' (mock acceptance regression)", () => {
    const x = reading({ price_per_head_usd: 28.75, headcount: 50, headcount_assumed: true, delivery_included: true, total_usd: 1150, sources: [src("price_per_head", "price_per_head=28.75", "quote.json"), src("total", "total=1150", "quote.json")] });
    expect(codes(validateQuote(x, 50))).toEqual([]);
  });

  it("adversarial: per-unit x quantity contradicting the subtotal, a deposit over the total, a deposit contradicting its share, a rate contradicting the total", () => {
    const items = validateQuote(reading({ price_per_head_usd: 25, headcount: 40, subtotal_usd: 1100, total_usd: 1100, sources: [src("price_per_head", "$25 each"), src("subtotal", "40 x $25 = $1,100"), src("total", "Total $1,100")] }), 40);
    expect(codes(items)).toContain("line_items_mismatch");
    const over = validateQuote(reading({ total_usd: 1200, deposit_usd: 1500, sources: [src("total", "Total $1,200"), src("deposit", "$1,500 deposit")] }), 40);
    expect(codes(over)).toEqual(["deposit_over_total"]);
    const share = validateQuote(reading({ total_usd: 1000, deposit_usd: 400, sources: [src("total", "Total $1,000"), src("deposit", "30% deposit ($400)")] }), 40, [], { text: "Total $1,000 delivered. 30% deposit ($400) due at booking." });
    expect(codes(share)).toEqual(["deposit_mismatch"]);
    const rate = validateQuote(reading({ subtotal_usd: 1000, delivery_included: true, tax_status: "included", tax_rate_percent: 8.625, total_usd: 1050, sources: [src("subtotal", "Food $1,000"), src("total", "Total $1,050 incl 8.625% tax")] }), 40);
    expect(codes(rate)).toEqual(["total_mismatch"]);
  });

  it("a deposit mentioned without an amount holds approval instead of 'the full total is due up front'; 'no deposit' does not", () => {
    const x = reading({ delivery_included: true, total_usd: 1000, sources: [src("total", "Total $1,000 delivered")] });
    expect(codes(validateQuote(x, 40, [], { text: "Total $1,000 delivered, tax included. A deposit is required to hold the date." }))).toEqual(["deposit_unquantified"]);
    expect(codes(validateQuote(x, 40, [], { text: "Total $1,000 delivered, tax included. No deposit required." }))).toEqual([]);
  });

  it("'Total $1,000 plus $75 delivery' with food unknown is never a firm $1,000: the all-in total is unknown", () => {
    const r = validateQuote(reading({ delivery_fee_usd: 75, delivery_included: false, total_usd: 1000, sources: [src("total", "Total $1,000"), src("delivery_fee", "plus $75 delivery")] }), 40);
    expect(r.flags).toContain("fees_unclear");
  });
});

describe("approval paths: nothing is approved or paid on figures that don't add up", { timeout: 60_000 }, () => {
  async function dealWith(caseId: string, extractor: ExtractorPort) {
    const env = await makeEnv({ extractor });
    const c = byId(caseId);
    const { request, budget_usd } = CORPUS_REQUEST;
    const deal = await env.engine.deal({ request, budget_usd, businesses: [{ name: c.vendor.name, email: c.vendor.email }] });
    const b = (await env.repo.getBusinesses(deal.job_id))[0]!;
    const rfq = env.emails.find((e) => e.to === c.vendor.email)!;
    env.clock.advance(20 * 60_000);
    const reply = async (own: string) => {
      const body = layoutReply(c.client, own, rfq.bodyText, { ourName: "Haggle", ourAddress: BUYER_INBOX, vendorAddress: c.vendor.email, subject: rfq.subject, sentAt: new Date(rfq.at) });
      await env.ingest({ from: c.vendor.email, subject: `Re: ${rfq.subject}`, bodyText: body, inReplyTo: [b.rfq_message_id!], references: [b.rfq_message_id!], threadId: `th_${c.id}` }, trusted);
      await env.engine.advanceJob(deal.job_id);
    };
    await reply(c.own!);
    return { env, jobId: deal.job_id, reply, vendor: c.vendor };
  }

  it("fx-08 end to end: shown as stated, blocked with the reason, not recommended, the business asked once, approval refused", async () => {
    const { env, jobId, vendor } = await dealWith("fx-08-conflicting-numbers", fixed(FX08));
    try {
      const board = await env.engine.getQuotes(jobId);
      const q = board.quotes[0]!;
      expect(q.total_usd).toBe(1050);
      expect(q.approvable).toBe(false);
      expect(q.approval_block).toMatchObject({ code: "numbers_dont_add_up" });
      expect(q.approval_block!.reason).toMatch(/add up to \$1,120\.00, but the stated total is \$1,050\.00/);
      expect(board.recommended_quote_id).toBeUndefined();
      const ask = env.emails.filter((e) => e.to === vendor.email).at(-1)!;
      expect(ask.bodyText).toMatch(/your correct all-in total \(the listed charges add up to \$1,120\.00, but the stated total is \$1,050\.00\)/);
      await expect(env.engine.requestApproval(jobId, q.quote_id, "imessage")).rejects.toMatchObject({ code: "quote_not_eligible", message: expect.stringMatching(/numbers_dont_add_up/) });
    } finally { env.restore(); }
  });

  it("an answer that doesn't restate the total ('delivery is included') keeps the block; the deal waits (past the window) and the corrected total clears it", async () => {
    let next: QuoteExtraction = FX08;
    const { env, jobId, reply } = await dealWith("fx-08-conflicting-numbers", { extract: async () => structuredClone(next) });
    try {
      next = reading({ delivery_included: true, sources: [] });
      env.clock.advance(20 * 60_000);
      await reply("Delivery is included.");
      let q = (await env.engine.getQuotes(jobId)).quotes.find((x) => x.status === "current")!;
      expect(q.approval_block?.code).toBe("numbers_dont_add_up");
      // Regression: the collection window closed with only this quote, and the deal failed ("no eligible
      // quote") before the business could answer; its correction then arrived as a late reply, ignored.
      env.clock.advance(20 * 60_000);
      await env.engine.advanceJob(jobId);
      expect((await env.repo.getJob(jobId))!.state).not.toBe("failed");
      next = reading({ delivery_included: true, total_usd: 1120, sources: [src("total", "Sorry, the total is $1,120 including delivery")] });
      await reply("Sorry, the total is $1,120 including delivery and tax.");
      q = (await env.engine.getQuotes(jobId)).quotes.find((x) => x.status === "current")!;
      expect(q.total_usd).toBe(1120);
      expect(q.approvable).toBe(true);
    } finally { env.restore(); }
  });

  it("a pay-by-link reply that mentions a deposit gets no clarification ask (only figures holding back a safe quote are asked about)", async () => {
    const x = reading({ delivery_included: true, total_usd: 990, payment_request: "external_link", sources: [src("total", "Total: $990 delivered, tax included")] });
    const { env, vendor } = await dealWith("c29-paylink-square", fixed(x));
    try {
      expect(env.emails.filter((e) => e.to === vendor.email)).toHaveLength(1); // the RFQ only
    } finally { env.restore(); }
  });

  it("c44 end to end: approvable with the $560 deposit, never 'the full $1,120 is due up front'", async () => {
    const { env, jobId } = await dealWith("c44-half-deposit", fixed(C44));
    try {
      const q = (await env.engine.getQuotes(jobId)).quotes[0]!;
      expect([q.approvable, q.deposit_usd]).toEqual([true, 560]);
      expect((await env.engine.approvalCaveats(jobId, q.quote_id)).join(" ")).not.toMatch(/full \$1,120/);
    } finally { env.restore(); }
  });

  it("on the corpus replies with the readings above: fx-11 and c13 approvable at the right all-in totals, c40 and c41 untouched", async () => {
    for (const [id, x, total] of [["fx-11-multipage-pdf-fees", FX11, 1108.5], ["c13-delivery-fee", C13, 1075], ["c40-fee-stack", C40, 1040], ["c41-minimum-order", C41, 1300]] as const) {
      const o = await observeCase(byId(id), fixed(x));
      expect([o.shown_total_usd, o.approval_block], id).toEqual([total, null]);
    }
  });

  it("a quote whose figures don't add up is never the cited basis of a counteroffer, never ranked", () => {
    const q = (o: Partial<CounterQuote> & Pick<CounterQuote, "quoteId" | "businessId" | "businessName">): CounterQuote => ({ totalCents: null, available: true, compliant: true, senderTrusted: true, round: 1, status: "current", confidence: 0.9, flags: [], ...o });
    const quotes = [q({ quoteId: "q-bad", businessId: "b1", businessName: "Presidio Grill", totalCents: 105_000, figuresInconsistent: true }), q({ quoteId: "q-a", businessId: "b2", businessName: "Bay Leaf", totalCents: 115_000 }), q({ quoteId: "q-b", businessId: "b3", businessName: "Fog Harbor", totalCents: 118_000 })];
    const plan = planCounteroffers(quotes, new Date("2026-10-23T20:00:00Z"));
    expect(plan.map((p) => p.basisQuoteId)).toEqual(["q-a"]);
    expect(plan.every((p) => !p.text.includes("1,050"))).toBe(true);
    expect(rankQuotes(quotes, null).rejected).toEqual([{ quoteId: "q-bad", businessId: "b1", reason: "numbers_dont_add_up" }]);
  });

  it("a record stored before the check is re-checked from its parts; a carried total keeps its issues", () => {
    const legacy = validateQuote(FX08, 40);
    delete (legacy as { financial?: unknown }).financial;
    expect(recordIssues(legacy).map((i) => i.code)).toEqual(["total_mismatch"]);
    const carried = mergeCarryOver(validateQuote(reading({ dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 45 }] }), 40), validateQuote(FX08, 40));
    expect([carried.total_cents, codes(carried)]).toEqual([105_000, ["total_mismatch"]]);
    // A deposit stated later settles "deposit mentioned, amount unknown".
    const prev = validateQuote(reading({ total_usd: 1000, delivery_included: true, sources: [src("total", "Total $1,000")] }), 40, [], { text: "Total $1,000 delivered. Deposit required." });
    const settled = mergeCarryOver(validateQuote(reading({ deposit_usd: 300, sources: [src("deposit", "$300 deposit")] }), 40), prev);
    expect([settled.deposit_cents, codes(settled)]).toEqual([30_000, []]);
  });

  it("the payment guard refuses money on an inconsistent quote, whatever was approved", () => {
    const now = new Date("2026-10-23T20:00:00Z");
    const approval = { id: "a1", job_id: "j1", quote_id: "q1", business_id: "b1", quote_total_cents: 105_000, payment_cents: 105_000, status: "approved", expires_at: "2026-10-24T00:00:00Z" };
    const quote = { id: "q1", business_id: "b1", total_cents: 105_000, deposit_cents: null, status: "current" };
    const input = { job: { id: "j1", state: "paying" }, approval, existingPayment: null, spendCapCents: 500_000, now };
    expect(checkApprovedPayment({ ...input, quote: { ...quote, figures_consistent: false } }, new Set())).toMatchObject({ ok: false, code: "QUOTE_INCONSISTENT" });
    expect(checkApprovedPayment({ ...input, quote }, new Set())).toMatchObject({ ok: true });
  });
});
