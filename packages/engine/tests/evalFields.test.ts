// Sprint 4 (E) evaluation: per-field scoring and money errors, every metric labelled with the
// extractor that produced it, the cost-capped live runner (never run here: no network), the raw-email
// baseline, and regression tests for the highest-risk parsing failures the f2 corpus found
// (`it.fails` = the safe behaviour, failing today; each is a handoff in the sprint report).
import { describe, expect, it } from "vitest";
import { loadCorpus, NEAR_DUPLICATES } from "../eval/corpus.ts";
import { EXTRACTOR_LABEL, liveExtractor, observeCase, runExtractionEval } from "../eval/extraction.ts";
import { scoreFields, type FieldObservation } from "../eval/fields.ts";
import { budgetedClient, EvalBudget, EvalBudgetExceeded, estimateInputTokens, FALLBACK_PRICE, liveEvalConfig, priceFor } from "../eval/liveBudget.ts";
import { runBaseline } from "../eval/baseline.ts";
import { CORPUS_DEALS, oracleExtraction, runCorpusDeal } from "../eval/orchestration.ts";
import { buildPdf } from "../eval/pdf.ts";
import { CORPUS_REQUEST } from "../eval/corpus.ts";
import { BUYER_INBOX, makeEnv, trusted } from "../eval/harness.ts";
import { layoutReply } from "../eval/clients.ts";
import type { ExtractorPort } from "../src/workflow/ports.ts";
import type { CorpusCase } from "../eval/types.ts";

const corpus = loadCorpus();
const byId = (id: string) => corpus.find((c) => c.id === id)!;

describe("corpus f2", () => {
  it("adds the missing real-world terms; the near-duplicate review names real cases", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(59);
    for (const tag of ["minimum", "options", "identity", "date"]) expect(corpus.some((c) => c.tags.includes(tag)), tag).toBe(true);
    expect(corpus.some((c) => c.labels.fees.some((f) => f.label === "gratuity"))).toBe(true);
    for (const [id, d] of Object.entries(NEAR_DUPLICATES)) {
      expect(byId(id), id).toBeDefined();
      expect(byId(d.of), d.of).toBeDefined();
    }
  });
});

describe("per-field scoring (fields.ts)", () => {
  const obs = (o: Partial<FieldObservation>): FieldObservation => ({ total_usd: null, deposit_usd: null, delivery: null, tax: null, fees: [], date_ok: null, requirements: {}, flags: [], shown_total_usd: null, shown_deposit_usd: null, approvable: false, ...o });
  it("a wrong amount on the board is a money error; approvable only when the human could approve it", () => {
    const c = byId("c14-service-charge"); // all-in $1,180
    const shownWrong = scoreFields(c, obs({ total_usd: 1000, shown_total_usd: 1000 }));
    expect(shownWrong.fields.total).toBe("wrong");
    expect(shownWrong.money_error_shown).toEqual(["total"]);
    expect(shownWrong.money_error_approvable).toEqual([]);
    expect(scoreFields(c, obs({ total_usd: 1000, shown_total_usd: 1000, approvable: true })).money_error_approvable).toEqual(["total"]);
    // A missing figure is not a money error (it shows "not stated" and blocks approval).
    const missing = scoreFields(c, obs({}));
    expect(missing.fields.total).toBe("missing");
    expect(missing.money_error_shown).toEqual([]);
    // No firm total in the reply: shown with a caveat is right, shown bare is a money error.
    const opts = byId("c45-multi-option");
    expect(scoreFields(opts, obs({ total_usd: 890, shown_total_usd: 890, flags: ["approximate_total"] })).money_error_shown).toEqual([]);
    expect(scoreFields(opts, obs({ total_usd: 890, shown_total_usd: 890 })).money_error_shown).toEqual(["total"]);
    // A deposit shown where none was stated, or the wrong one, is a money error too.
    expect(scoreFields(byId("c44-half-deposit"), obs({ total_usd: 1120, shown_total_usd: 1120, deposit_usd: 112, shown_deposit_usd: 112 })).money_error_shown).toEqual(["deposit"]);
  });

  it("identity and date are scored, and only a detection counts", () => {
    const id = scoreFields(byId("c46-identity-mismatch"), obs({ total_usd: 990, shown_total_usd: 990 }));
    expect(id.fields.identity).toBe("missing");
    expect(scoreFields(byId("c46-identity-mismatch"), obs({ flags: ["identity_mismatch"] })).fields.identity).toBe("correct");
    expect(scoreFields(byId("c43-other-date"), obs({ date_ok: false })).fields.date).toBe("correct");
    expect(scoreFields(byId("c01-gmail-clean"), obs({})).fields.date).toBe("n/a");
  });
});

describe("extractor labelling (fake readers vs the real Claude call)", { timeout: 120_000 }, () => {
  it("every summary names its extractor; the oracle validates the scorer; the fallback never makes an approvable money error", async () => {
    const det = await runExtractionEval(corpus, "deterministic", {});
    const oracle = await runExtractionEval(corpus, "oracle", {});
    expect(det).toMatchObject({ extractor: "deterministic", extractor_label: EXTRACTOR_LABEL.deterministic });
    expect(oracle).toMatchObject({ extractor: "oracle", extractor_label: EXTRACTOR_LABEL.oracle });
    expect(det.extractor_label).not.toBe(oracle.extractor_label);
    expect(det.live).toBeUndefined();
    expect(det.fetches + oracle.fetches).toBe(0);
    // The oracle reads every label perfectly: the scorer finds no money error and every total right.
    expect(oracle.fields.money_errors_shown.count).toBe(0);
    expect(oracle.fields.fields.total).toMatchObject({ wrong: 0, missing: 0 });
    // The keyword fallback shows some wrong amounts (labelled as such) but none is ever approvable.
    expect(det.fields.money_errors_approvable.count).toBe(0);
    expect(det.fields.money_errors_shown.cases).toEqual(expect.arrayContaining(["c14-service-charge (total)", "c38-total-plus-tax (total)", "c39-gratuity (total)"]));
  });

  it("the Claude extractor refuses to run without opt-in, key and a positive dollar cap, before any network", async () => {
    expect(liveEvalConfig({})).toMatchObject({ ok: false });
    expect(liveEvalConfig({ HAGGLE_EVAL_LIVE: "1" })).toMatchObject({ ok: false, reason: expect.stringMatching(/ANTHROPIC_API_KEY/) });
    for (const cap of [undefined, "", "0", "-1", "abc"]) {
      const r = liveEvalConfig({ HAGGLE_EVAL_LIVE: "1", ANTHROPIC_API_KEY: "sk-test", ...(cap !== undefined ? { HAGGLE_EVAL_MAX_USD: cap } : {}) });
      expect(r, String(cap)).toMatchObject({ ok: false, reason: expect.stringMatching(/HAGGLE_EVAL_MAX_USD/) });
    }
    expect(liveEvalConfig({ HAGGLE_EVAL_LIVE: "1", ANTHROPIC_API_KEY: "sk-test", HAGGLE_EVAL_MAX_USD: "2.5" })).toMatchObject({ ok: true, maxUsd: 2.5, model: "claude-sonnet-5-5" });
    expect(liveExtractor({ HAGGLE_EVAL_LIVE: "1", ANTHROPIC_API_KEY: "sk-test" })).toMatchObject({ ok: false });
    const real = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => { fetched++; throw new Error("no network in tests"); }) as typeof fetch;
    try {
      await expect(runExtractionEval(corpus.slice(0, 1), "claude", { HAGGLE_EVAL_LIVE: "1", ANTHROPIC_API_KEY: "sk-test" })).rejects.toThrow(/not run: HAGGLE_EVAL_MAX_USD/);
    } finally {
      globalThis.fetch = real;
    }
    expect(fetched).toBe(0);
  });

  it("the cap is enforced per call from a conservative token count, before the call is sent", async () => {
    const pdf = Buffer.from(buildPdf({ filename: "q.pdf", pages: [["a"], ["b"], ["c"]] })).toString("base64");
    const params = { model: "claude-sonnet-5-5", max_tokens: 4096, system: "x".repeat(3000), messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } }, { type: "text", text: "y".repeat(300) }] }] };
    const tokens = estimateInputTokens(params);
    expect(tokens).toBeGreaterThanOrEqual(3 * 3000 + 1100); // 3 PDF pages + ~3.3k chars / 3
    expect(priceFor("claude-sonnet-5-5")).toEqual({ input: 2, output: 10 });
    expect(priceFor("some-new-model")).toEqual(FALLBACK_PRICE);
    const budget = new EvalBudget(0.1, "claude-sonnet-5-5");
    let sent = 0;
    const fake = { messages: { parse: async (_p: unknown) => { sent++; return { usage: { input_tokens: 10_000, output_tokens: 500 } }; } } };
    const client = budgetedClient(fake as never, budget) as unknown as typeof fake;
    await client.messages.parse(params as never);
    expect(sent).toBe(1);
    expect(budget.spentUsd).toBeCloseTo((10_000 * 2 + 500 * 10) / 1e6, 6);
    // Each further call reserves ~$0.065 (input est. + 4,096 output tokens): the second fits, the third would cross $0.10.
    await client.messages.parse(params as never);
    await expect(client.messages.parse(params as never)).rejects.toBeInstanceOf(EvalBudgetExceeded);
    expect(sent).toBe(2);
    expect(budget.refused).toBe(1);
    expect(() => new EvalBudget(0, "claude-sonnet-5-5")).toThrow();
  });
});

describe("customer journey: Haggle vs a raw-email baseline (simulated vendors, same reader)", { timeout: 120_000 }, () => {
  it("is reproducible; the baseline completes by buying wrong, Haggle with the same reader never buys wrong", async () => {
    const a = runBaseline(CORPUS_DEALS);
    expect(JSON.stringify(runBaseline(CORPUS_DEALS))).toBe(JSON.stringify(a));
    expect(a.every((r) => r.arm === "baseline:raw-email")).toBe(true);
    const wrong = a.filter((r) => r.completed && !r.correct_purchase);
    expect(wrong.length).toBeGreaterThan(0);
    expect(a.some((r) => r.failures.some((f) => /instructions to the AI|outside the thread/.test(f)))).toBe(true);
    for (const d of CORPUS_DEALS) {
      const h = await runCorpusDeal(d, "deterministic");
      expect(h.completed && h.winner_ok === false, d.id).toBe(false);
    }
  });
});

/** A correct Claude-style reading of a corpus reply (what a careful model returns), with every hard requirement met. */
function claudeLike(c: CorpusCase): ExtractorPort {
  return { async extract() { return { ...oracleExtraction(c.labels), requirement_checks: [{ requirement_id: "req_veg", met: true, evidence: "12 vegetarian", note: "count stated" }, { requirement_id: "req_delivery", met: true, evidence: "delivered", note: "stated" }] }; } };
}

async function boardFor(c: CorpusCase, extractor: ExtractorPort) {
  const env = await makeEnv({ extractor });
  try {
    const { request, budget_usd } = CORPUS_REQUEST;
    const deal = await env.engine.deal({ request, budget_usd, businesses: [{ name: c.vendor.name, email: c.vendor.email }] });
    const b = (await env.repo.getBusinesses(deal.job_id))[0]!;
    const rfq = env.emails.find((e) => e.to === c.vendor.email)!;
    env.clock.advance(20 * 60_000);
    const body = layoutReply(c.client, c.own, rfq.bodyText, { ourName: "Haggle", ourAddress: BUYER_INBOX, vendorAddress: c.vendor.email, subject: rfq.subject, sentAt: new Date(rfq.at) });
    await env.ingest({ from: c.vendor.email, subject: `Re: ${rfq.subject}`, bodyText: body, inReplyTo: [b.rfq_message_id!], references: [b.rfq_message_id!], threadId: `th_${c.id}` }, trusted);
    await env.engine.advanceJob(deal.job_id);
    return await env.engine.getQuotes(deal.job_id);
  } finally {
    env.restore();
  }
}

describe("highest-risk parsing failures (f2 corpus): regression tests", { timeout: 60_000 }, () => {
  it("regression, formerly a known gap: a quote for ANOTHER date is never approvable without a caveat", async () => {
    // c43: "booked on the 29th, but we can do Friday the 30th". QuoteExtraction has no offered-date field and
    // the request date is not a requirement, so even a perfect reading yields an approvable, recommended quote.
    const b = await boardFor(byId("c43-other-date"), claudeLike(byId("c43-other-date")));
    const q = b.quotes[0]!;
    expect(q.approvable && q.flags.length === 0).toBe(false);
  });

  it("regression, formerly a known gap: a reply signed by a different business than the mailbox is flagged before approval", async () => {
    const b = await boardFor(byId("c46-identity-mismatch"), claudeLike(byId("c46-identity-mismatch")));
    const q = b.quotes[0]!;
    expect(q.approvable && q.flags.length === 0).toBe(false);
  });

  it("fallback reader (regression): 'Total: $1,050 ... plus 8.625% sales tax' is never shown as a firm total", async () => {
    const o = await observeCase(byId("c38-total-plus-tax"));
    expect(o.shown_total_usd === null || o.flags.includes("tax_excluded")).toBe(true);
  });

  it("fallback reader (regression): a gratuity added on top is never dropped from the shown total", async () => {
    const o = await observeCase(byId("c39-gratuity"));
    expect(o.shown_total_usd === null || o.shown_total_usd === 1200 || o.flags.includes("fees_unclear")).toBe(true);
  });

  it("the fallback reader's wrong totals are never approvable (fail-safe holds on every f2 case)", async () => {
    for (const c of corpus.filter((x) => x.tags.includes("f2"))) expect((await observeCase(c)).approvable, c.id).toBe(false);
  });
});
