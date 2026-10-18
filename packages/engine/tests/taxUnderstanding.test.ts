// Live miss (2026-10-18, Mission Eats by phone): the business said its tax rate and confirmed the
// agent's all-in read-back, yet the board said "Tax isn't included". Claude now judges tax per quote
// (tax_status + tax_rate_percent + tax_evidence); code only does arithmetic: the tax inside a
// confirmed total, the rate on the food when tax is on top, and an earlier rate for a later price.
// Real transcripts: fixtures/live-misses/tax-understanding.json. Fake extractor, no network.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { disabledPayer, HaggleEngine, InMemoryRepository, mergeCarryOver, StubBrain } from "../src/index.ts";
import { QuoteExtraction as QuoteExtractionSchema, type QuoteExtraction, type QuoteRecord } from "../src/parsing/extraction.ts";
import { dropAgentOnlyAmounts, percentsIn } from "../src/parsing/heuristic.ts";
import { SYSTEM, type ExtractionRequest } from "../src/parsing/parseReply.ts";
import { validateQuote } from "../src/parsing/validate.ts";
import type { Request } from "../src/contract.ts";

type Expect = { total_cents: number; tax_cents: number | null; tax_status?: string; tax_rate_percent: number | null; tax_excluded: boolean };
type Case = { name: string; request: string; transcript: string; extraction: QuoteExtraction; live_extraction?: QuoteExtraction; expect: Expect };
const FX = JSON.parse(readFileSync(new URL("../../../fixtures/live-misses/tax-understanding.json", import.meta.url), "utf8")) as {
  requests: Record<string, Request & { source_job: string }>;
  cases: Case[];
  counter_call: { request: string; round1: string; transcript: string; extraction_not_mentioned: QuoteExtraction; extraction_from_history: QuoteExtraction; expect: Expect };
};
const requestOf = (name: string): Request => {
  const { source_job: _s, ...r } = FX.requests[name]!;
  return r;
};
const caseOf = (name: string) => FX.cases.find((c) => c.name === name)!;
/** What the engine does with a call: the agent-only safety net, then validation (and the carry-over). */
const read = (x: QuoteExtraction, transcript: string, quantity: number, prior: QuoteRecord | null = null) =>
  mergeCarryOver(validateQuote(dropAgentOnlyAmounts(structuredClone(x), transcript), quantity, [], { prior }), prior);

function expectTax(r: QuoteRecord, e: Expect) {
  expect(r.total_cents).toBe(e.total_cents);
  expect(r.tax_cents).toBe(e.tax_cents);
  if (e.tax_status) expect(r.tax?.status).toBe(e.tax_status);
  expect(r.tax?.rate_percent ?? null).toBe(e.tax_rate_percent);
  if (e.tax_excluded) expect(r.flags).toContain("tax_excluded");
  else expect(r.flags).not.toContain("tax_excluded");
}

describe("tax understood from what the business said (fixtures/live-misses/tax-understanding.json)", () => {
  it.each(FX.cases.map((c) => [c.name, c] as const))("%s", (_n, c) => {
    const r = read(c.extraction, c.transcript, requestOf(c.request).quantity!);
    expectTax(r, c.expect);
    expect(r.tax_included).toBe(c.expect.tax_status === "included" ? true : c.expect.tax_status === "added_on_top" ? false : null);
    // A stated, confirmed total is never relabelled as computed.
    if (c.extraction.total_usd !== null) expect(r.sources.total?.source).not.toMatch(/^computed/);
  });

  it.each(FX.cases.filter((c) => c.live_extraction).map((c) => [c.name, c] as const))("the live Claude output that caused the miss (%s) no longer says tax is excluded", (_n, c) => {
    // Old schema: tax_included false + a rate + the confirmed all-in total. The business's own parts
    // plus its rate add up to that total, so the tax is inside it.
    const r = read(c.live_extraction!, c.transcript, requestOf(c.request).quantity!);
    expect(r.flags).not.toContain("tax_excluded");
    expect(r.total_cents).toBe(c.expect.total_cents);
    expect(r.tax_cents).toBe(c.expect.tax_cents);
    expect(r.tax?.status).toBe("included");
    expect(r.sources.tax?.source).toMatch(/^computed: stated total - food - delivery/);
  });

  it("the read-back total and rate the business confirmed survive the agent-only safety net", () => {
    const c = caseOf("five-percent-then-confirmed-all-in");
    const x = dropAgentOnlyAmounts(structuredClone(c.extraction), c.transcript);
    expect(x.total_usd).toBe(1680);
    expect(x.tax_rate_percent).toBe(5);
    expect(percentsIn("And the tax rate is ten percent.")).toContain(10);
    expect(percentsIn("then tax is 8 percent")).toContain(8);
    expect(percentsIn("plus 8.5% tax")).toContain(8.5);
  });

  it("a tax rate only the agent said is not the business's rate (tax on top, amount unknown: flagged)", () => {
    const c = caseOf("tax-never-mentioned");
    const t = "local: What would 40 lunches cost?\nremote: Thirteen dollars per meal, plus a hundred for delivery.\nlocal: Is there tax on that, like 8 percent?\nremote: There's tax, yeah, I'd have to check.";
    const x = { ...c.extraction, tax_status: "added_on_top" as const, tax_rate_percent: 8, tax_evidence: "There's tax, yeah" };
    const r = read(x, t, 40);
    expect(r.tax?.rate_percent).toBeNull();
    expect(r.total_cents).toBe(62_000);
    expect(r.flags).toContain("tax_excluded");
  });

  it("an unexplained tax judgement (no evidence) is not trusted", () => {
    const c = caseOf("tax-never-mentioned");
    const r = read({ ...c.extraction, tax_status: "included", tax_evidence: "" }, c.transcript, 40);
    expect(r.tax?.status).toBe("not_mentioned");
    expect(r.flags).toContain("tax_excluded");
  });

  it("tax on top with a stated rate is added to a total worked out from parts (on the food), and never flagged", () => {
    const c = caseOf("tax-never-mentioned");
    const r = read({ ...c.extraction, tax_status: "added_on_top", tax_rate_percent: 8, tax_evidence: "and then tax is 8 percent" }, "remote: Thirteen dollars per meal, plus a hundred for delivery. And then tax is 8 percent.", 40);
    expect(r.tax_cents).toBe(4_160);
    expect(r.total_cents).toBe(66_160);
    expect(r.sources.total?.source).toMatch(/^computed from stated price per head x headcount \+ delivery fee \+ 8% tax/);
    expect(r.flags).not.toContain("tax_excluded");
  });

  it("'$1,000 plus 8% tax' as a stated total: the tax is added on top and the total is labelled computed", () => {
    const x: QuoteExtraction = { ...caseOf("all-in-including-tax-in-words").extraction, total_usd: 1000, tax_status: "added_on_top", tax_rate_percent: 8, tax_evidence: "$1,000 plus 8% tax",
      sources: [{ field: "total", source: "email body", excerpt: "$1,000 plus 8% tax" }] };
    const r = validateQuote(x, 100);
    expect(r.tax_cents).toBe(8_000);
    expect(r.total_cents).toBe(108_000);
    expect(r.sources.total?.source).toMatch(/^computed from stated total \+ 8% tax/);
    expect(r.flags).not.toContain("tax_excluded");
  });

  it("a rate above 20% is ignored, never applied (tax on top stays unknown and is flagged)", () => {
    const c = caseOf("tax-never-mentioned");
    const r = read({ ...c.extraction, tax_status: "added_on_top", tax_rate_percent: 45, tax_evidence: "45 percent tax" }, "remote: 45 percent tax", 40);
    expect(r.tax_cents).toBeNull();
    expect(r.tax?.rate_percent).toBeNull();
    expect(r.flags).toContain("tax_excluded");
  });
});

describe("a tax decision carries across a business's later replies (counter call, round 2)", () => {
  const cc = FX.counter_call;
  const round1 = () => {
    const c = caseOf(cc.round1);
    return read(c.extraction, c.transcript, 100);
  };

  it("round 2 gives only a new per-person price: the 5% from round 1 applies, on the base the business confirmed (food + delivery)", () => {
    const r1 = round1();
    expect(r1.tax?.on_delivery).toBe(true);
    const r2 = read(cc.extraction_not_mentioned, cc.transcript, 100, r1);
    expectTax(r2, cc.expect);
    expect(r2.tax?.carried).toBe(true);
    expect(r2.sources.total?.source).toMatch(/^computed from stated price per head x headcount \+ delivery fee stated earlier \+ 5% tax stated earlier/);
  });

  it("the same when Claude reads the rate from the earlier call itself", () => {
    const r2 = read(cc.extraction_from_history, cc.transcript, 100, round1());
    expectTax(r2, cc.expect);
  });

  it("a later call that says nothing about price or tax keeps the confirmed all-in total and its tax", () => {
    const r1 = round1();
    const empty: QuoteExtraction = { ...cc.extraction_not_mentioned, price_per_head_usd: null, headcount: null, sources: [], missing_fields: ["total_usd"] };
    const r2 = read(empty, "local: Could you confirm delivery on October 22nd?\nremote: Yeah, yeah", 100, r1);
    expect(r2.total_cents).toBe(168_000);
    expect(r2.tax_cents).toBe(8_000);
    expect(r2.tax?.status).toBe("included");
    expect(r2.flags).not.toContain("tax_excluded");
  });

  it("an old tax amount is not carried onto a new price", () => {
    const r1 = round1();
    const r2 = read({ ...cc.extraction_not_mentioned, total_usd: 1500, tax_status: "included", tax_evidence: "fifteen hundred all in", price_per_head_usd: null, headcount: null,
      sources: [{ field: "total", source: "call transcript", excerpt: "fifteen hundred all in" }] }, "remote: I can do fifteen hundred all in.", 100, r1);
    expect(r2.total_cents).toBe(150_000);
    expect(r2.tax_cents).toBeNull();
    expect(r2.flags).not.toContain("tax_excluded");
  });
});

describe("the extractor is asked for a tax judgement", () => {
  it("schema: tax_status (included | added_on_top | not_mentioned), rate and evidence; no tax_included for Claude to set", () => {
    const shape = QuoteExtractionSchema.shape;
    expect(shape.tax_status.options).toEqual(["included", "added_on_top", "not_mentioned"]);
    expect(shape.tax_evidence.safeParse("").success).toBe(true);
    expect(shape.tax_rate_percent.safeParse(null).success).toBe(true);
    expect("tax_included" in shape).toBe(false);
  });

  it("prompt: a confirmed all-in total with a named rate is included; an earlier rate still applies; no 'tax_included false' rule", () => {
    expect(SYSTEM).toMatch(/tax_status is about the total you set/);
    expect(SYSTEM).toMatch(/This holds even when it also named the rate/);
    expect(SYSTEM).toMatch(/tax rate or decision from the earlier conversation still applies/);
    expect(SYSTEM).not.toMatch(/tax_included false/);
  });
});

describe("engine: a Mission Eats call with the rate and a confirmed all-in total, then a counter call", () => {
  it("never flags tax as excluded, and round 2 is worked out with the round-1 rate and delivery", async () => {
    const c = caseOf(FX.counter_call.round1);
    const cc = FX.counter_call;
    const repo = new InMemoryRepository();
    const seen: { request: ExtractionRequest; bodyText: string }[] = [];
    const calls: { toNumber: string }[] = [];
    const extractor = {
      async extract(i: { request: ExtractionRequest; bodyText: string }) {
        seen.push(i);
        if (i.bodyText.includes("fourteen dollars per person")) return structuredClone(cc.extraction_not_mentioned);
        if (i.bodyText.includes("there's a 5 percent")) return structuredClone(c.extraction);
        throw new Error(`no fixture for: ${i.bodyText.slice(0, 80)}`);
      },
    };
    const engine = new HaggleEngine({
      repo, extractor, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
      email: { async send() { return { providerId: "em_1", status: "sent", idempotentReplay: false, messageId: "<em_1@haggle.test>" }; } },
      phone: { async placeCall(r) { calls.push(r); return { callId: `call_${calls.length}` }; } },
      config: {
        mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
        globalPaymentCapCents: 500_000, maxRounds: 1, callCooldownMs: 0,
      },
    });
    const deal = await engine.deal({ request: requestOf(cc.request), budget_usd: 5000, businesses: [{ name: "Mission Eats", phone: "+14155550104" }] });
    await engine.advanceJob(deal.job_id);
    expect((await engine.ingestCall({ callId: "call_1", outcome: "completed", transcript: c.transcript })).outcome).toBe("stored");
    await engine.advanceJob(deal.job_id);
    let q = (await repo.listQuotes(deal.job_id)).find((x) => x.status === "current")!;
    expect(q.total_cents).toBe(168_000);
    expect(q.record.flags).not.toContain("tax_excluded");
    expect(q.record.tax?.status).toBe("included");
    const flagged = async () => (await repo.listEvents(deal.job_id)).filter((e) => e.type === "flag" && e.data.flag === "tax_excluded");
    expect(await flagged()).toEqual([]);

    // Round 2: a call Haggle placed (counter), whose transcript gives only a new per-person price.
    const b = (await repo.getBusinesses(deal.job_id))[0]!;
    await repo.insertMessage({
      job_id: deal.job_id, business_id: b.business_id, approval_id: null, direction: "out", kind: "followup", channel: "phone", provider_email_id: "call_counter", idempotency_key: null,
      rfc_message_id: null, thread_id: null, from_address: null, to_address: b.phone, subject: null, body_text: "Ask for a better per-person price.", attachments: [], attachments_download_url: null,
      sender_trusted: true, trust_reason: null, matched_via: null, parse_status: "none", quarantine_reason: null, round: null, simulated: false,
    });
    expect((await engine.ingestCall({ callId: "call_counter", outcome: "completed", transcript: cc.transcript })).outcome).toBe("stored");
    await engine.advanceJob(deal.job_id);
    // Claude saw the earlier call (with the 5%) as context.
    expect(seen.at(-1)!.request.history?.some((h) => h.from === "business" && /5 percent/.test(h.text))).toBe(true);
    q = (await repo.listQuotes(deal.job_id)).find((x) => x.status === "current")!;
    expect(q.total_cents).toBe(cc.expect.total_cents);
    expect(q.record.tax_cents).toBe(cc.expect.tax_cents);
    expect(q.record.flags).not.toContain("tax_excluded");
    expect(await flagged()).toEqual([]);
  });
});
