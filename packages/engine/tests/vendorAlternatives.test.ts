// Vendor alternatives (live Claude eval 2026-10-23): an offer for another date (c43) was read as a
// decline and lost; two priced options (c45) became a bare "Which would you prefer?" with neither price.
// Both are now kept for the human, and neither is ever approvable, recommended or cited as a price
// until the business confirms terms that match the request. Readings are hand-written in the shape
// Claude produced; the replies are the corpus's own (eval/corpus.ts), through the real ingest path.
import { describe, expect, it } from "vitest";
import { CORPUS_REQUEST, loadCorpus } from "../eval/corpus.ts";
import { observeCase } from "../eval/extraction.ts";
import { layoutReply } from "../eval/clients.ts";
import { BUYER_INBOX, makeEnv, trusted } from "../eval/harness.ts";
import { optionsLine, pricedOptions } from "../src/parsing/options.ts";
import type { QuoteExtraction } from "../src/parsing/extraction.ts";
import type { ExtractorPort } from "../src/workflow/ports.ts";

const corpus = loadCorpus();
const byId = (id: string) => corpus.find((c) => c.id === id)!;
type Src = QuoteExtraction["sources"][number];
const src = (field: Src["field"], excerpt: string): Src => ({ field, source: "email body", excerpt });
function reading(o: Partial<QuoteExtraction> = {}): QuoteExtraction {
  return {
    available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null,
    tax_status: "included", tax_rate_percent: null, tax_evidence: "tax included", total_usd: null, deposit_usd: null, menu_items: [],
    dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }], valid_until: null, questions: [], payment_request: "none", instructions_to_agent: false,
    sources: [], missing_fields: [], confidence: 0.9, other_fees: [], requirement_checks: [
      { requirement_id: "req_veg", met: true, evidence: "12 vegetarian", note: "stated" },
      { requirement_id: "req_delivery", met: true, evidence: "delivered", note: "stated" },
    ], ...o,
  };
}
const fixed = (x: QuoteExtraction): ExtractorPort => ({ extract: async () => structuredClone(x) });

// As Claude read them (live eval 2026-10-23).
const C43 = reading({ available: false, total_usd: 1000, sources: [src("total", "Total $1,000 delivered, tax included")] });
const C45 = reading({ menu_items: ["sandwich platters", "hot buffet"], questions: [{ text: "Which would you prefer?", needs_answer_to_quote: true }] });

describe("pricedOptions: the business's own labelled prices", () => {
  it("reads two or more labelled, priced options; one labelled price is just a quote", () => {
    expect(pricedOptions(byId("c45-multi-option").own!)).toEqual([
      { label: "Option A, sandwich platters", cents: 89_000, excerpt: "Option A, sandwich platters: $890" },
      { label: "Option B, hot buffet", cents: 118_000, excerpt: "Option B, hot buffet: $1,180" },
    ]);
    expect(pricedOptions("Package 1 (boxed lunches) - $950.50; Package 2 (buffet) - $1,240")).toHaveLength(2);
    expect(pricedOptions("Option A it is: $890 total, delivered.")).toEqual([]);
    expect(pricedOptions("Total $1,000. We have options for dessert.")).toEqual([]);
    expect(optionsLine(pricedOptions(byId("c45-multi-option").own!))).toBe("Option A, sandwich platters $890; Option B, hot buffet $1,180");
  });
});

describe("vendor alternatives through the real ingest path", { timeout: 60_000 }, () => {
  async function deal(vendors: { caseId: string; x: QuoteExtraction }[]) {
    const byText = new Map(vendors.map((v) => [byId(v.caseId).own!.slice(0, 30), v.x]));
    let next: QuoteExtraction | null = null;
    const env = await makeEnv({ extractor: { extract: async (i) => structuredClone(next ?? [...byText].find(([k]) => i.bodyText.includes(k))![1]) } });
    const { request, budget_usd } = CORPUS_REQUEST;
    const cases = vendors.map((v) => byId(v.caseId));
    const d = await env.engine.deal({ request, budget_usd, businesses: cases.map((c) => ({ name: c.vendor.name, email: c.vendor.email })) });
    const businesses = await env.repo.getBusinesses(d.job_id);
    env.clock.advance(20 * 60_000);
    const reply = async (caseId: string, own: string, x?: QuoteExtraction) => {
      const c = byId(caseId);
      const b = businesses.find((x) => x.email === c.vendor.email)!;
      const rfq = env.emails.find((e) => e.to === c.vendor.email)!;
      next = x ?? null;
      const body = layoutReply(c.client, own, rfq.bodyText, { ourName: "Haggle", ourAddress: BUYER_INBOX, vendorAddress: c.vendor.email, subject: rfq.subject, sentAt: new Date(rfq.at) });
      await env.ingest({ from: c.vendor.email, subject: `Re: ${rfq.subject}`, bodyText: body, inReplyTo: [b.rfq_message_id!], references: [b.rfq_message_id!], threadId: `th_${c.id}` }, trusted);
      await env.engine.advanceJob(d.job_id);
    };
    for (const c of cases) await reply(c.id, c.own!);
    return { env, jobId: d.job_id, reply };
  }

  it("c43: an offer for another date is kept as an alternative, never a decline, and never approvable", async () => {
    const { env, jobId } = await deal([{ caseId: "c43-other-date", x: C43 }]);
    try {
      const board = await env.engine.getQuotes(jobId);
      expect(board.businesses[0]!.status).not.toBe("declined");
      const q = board.quotes[0]!;
      expect([q.total_usd, q.approvable, q.approval_block?.code]).toEqual([1000, false, "date_mismatch"]);
      expect(q.approval_block!.reason).toMatch(/quoted for 2026-10-30, not the requested date/);
      expect(board.recommended_quote_id).toBeUndefined();
      // Regression: the deal used to end "without a usable quote" at once, losing the alternative.
      expect((await env.repo.getJob(jobId))!.state).not.toBe("failed");
      expect(board.next).toMatch(/none can be approved yet: Laurel Village Deli: .*quoted for 2026-10-30, not the requested date; agree the date with them first\. Tell the user/);
      await expect(env.engine.requestApproval(jobId, q.quote_id, "imessage")).rejects.toMatchObject({ code: "quote_not_eligible" });
    } finally { env.restore(); }
  });

  it("a cheaper offer for another date is never cited to another business as a competing price", async () => {
    const C01 = reading({ total_usd: 1150, deposit_usd: 200, sources: [src("total", "Total: $1,150 including delivery and tax"), src("deposit", "A $200 deposit")] });
    const { env, jobId } = await deal([{ caseId: "c43-other-date", x: C43 }, { caseId: "c01-gmail-clean", x: C01 }]);
    try {
      env.clock.advance(40 * 60_000);
      await env.engine.advanceJob(jobId);
      const toBayLeaf = env.emails.filter((e) => e.to === byId("c01-gmail-clean").vendor.email).map((e) => e.bodyText).join("\n");
      expect(toBayLeaf).not.toMatch(/\$1,000/);
      expect((await env.repo.listEvents(jobId)).some((e) => e.type === "reply" && /^Counteroffer/.test(String(e.data.summary ?? "")))).toBe(false);
    } finally { env.restore(); }
  });

  it("c45: both priced options are kept and shown in the question; nothing is approvable until the business confirms the choice", async () => {
    const { env, jobId, reply } = await deal([{ caseId: "c45-multi-option", x: C45 }]);
    try {
      let board = await env.engine.getQuotes(jobId);
      const q = board.quotes[0]!;
      expect([q.total_usd, q.approvable, q.approval_block?.code]).toEqual([null, false, "no_total"]);
      expect(board.pending_questions[0]!.text).toBe("Which would you prefer? (the business's options: Option A, sandwich platters $890; Option B, hot buffet $1,180)");
      expect((await env.repo.listQuotes(jobId))[0]!.record.options).toHaveLength(2);
      // The deal waits for the human's choice (it used to end at once), and never points at a recommendation that doesn't exist.
      expect((await env.repo.getJob(jobId))!.state).not.toBe("failed");
      expect(board.next).not.toMatch(/recommended_quote_id/);
      // The human picks; the business confirms the chosen option's firm total: an ordinary, approvable quote.
      await reply("c45-multi-option", "Great, Option A it is: $890 total, delivered, tax included, 12 vegetarian.", reading({ total_usd: 890, sources: [src("total", "Option A it is: $890 total")] }));
      board = await env.engine.getQuotes(jobId);
      const now = board.quotes.find((x) => x.status === "current")!;
      expect([now.total_usd, now.approvable]).toEqual([890, true]);
    } finally { env.restore(); }
  });

  it("when the reader picks one option as 'the total' while the business asks which, the choice stays the human's", async () => {
    const picked = reading({ ...C45, total_usd: 890, sources: [src("total", "Option A, sandwich platters: $890")] });
    const o = await observeCase(byId("c45-multi-option"), fixed(picked));
    expect([o.shown_total_usd, o.approvable, o.outcome]).toEqual([null, false, "quote"]);
  });

  it("the eval counts the engine's own date and delivery-window checks (c42, c43)", async () => {
    const c42 = reading({ total_usd: 1080, sources: [src("total", "Total: $1,080 delivered, tax included")] });
    expect((await observeCase(byId("c42-delivery-window"), fixed(c42))).date_ok).toBe(false);
    expect((await observeCase(byId("c43-other-date"), fixed(C43))).date_ok).toBe(false);
  });
});
