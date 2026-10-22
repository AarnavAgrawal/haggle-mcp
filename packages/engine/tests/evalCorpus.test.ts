// The WS-F evaluation corpus and harness (packages/engine/eval): the corpus is well formed, runs are
// reproducible, and the safety invariants hold on every case. Bugs the corpus found are `it.fails`
// (the test states the right behaviour). Simulated data only; no network.
import { describe, expect, it } from "vitest";
import { cleanEmailBody } from "../src/inbound/emailBody.ts";
import { buildRfqEmail } from "../src/outbound/rfq.ts";
import { layoutReply } from "../eval/clients.ts";
import { loadCorpus } from "../eval/corpus.ts";
import { observeCase, runExtractionEval } from "../eval/extraction.ts";
import { CORPUS_DEALS, runCorpusDeal, runFleetDeal } from "../eval/orchestration.ts";
import { buildPdf } from "../eval/pdf.ts";
import type { ClientStyle } from "../eval/types.ts";

const corpus = loadCorpus();
const byId = (id: string) => corpus.find((c) => c.id === id)!;
const RFQ = buildRfqEmail({ shortCode: "AB12", businessName: "Bay Leaf", what: "lunch catering", quantity: 40, date: "2026-10-29", time: "12:00", location: "San Francisco, CA", venue: "500 Howard St", requirements: ["At least 12 vegetarian meals", "Delivery included"], replyBy: new Date("2026-10-27T17:00:00Z"), budgetHintCents: 120_000 });
const META = { ourName: "Haggle", ourAddress: "haggle@inkboxmail.test", vendorAddress: "quotes@bayleaf.example", subject: RFQ.subject, sentAt: new Date("2026-10-20T16:00:00Z") };

describe("corpus", () => {
  it("is well formed: unique ids and vendors, consistent labels, valid PDFs, the fixtures it reuses exist", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(45);
    expect(new Set(corpus.map((c) => c.id)).size).toBe(corpus.length);
    const own = corpus.filter((c) => c.origin === "own");
    expect(new Set(own.map((c) => c.vendor.email)).size).toBe(own.length);
    for (const c of corpus) {
      const l = c.labels;
      if (l.compliant === true) expect(l.veg_count === null || l.veg_count >= 12, c.id).toBe(true);
      if (l.veg_count !== null && l.veg_count < 12) expect(l.compliant, c.id).toBe(false);
      if (l.delivery === false) expect(l.compliant, c.id).toBe(false);
      if (l.deposit_usd !== null && l.total_usd !== null) expect(l.deposit_usd, c.id).toBeLessThanOrEqual(l.total_usd);
      for (const p of c.pdfs ?? []) {
        const s = Buffer.from(buildPdf(p)).toString("latin1");
        expect(s.startsWith("%PDF-1.4") && s.includes("startxref") && s.trimEnd().endsWith("%%EOF"), c.id).toBe(true);
      }
    }
    expect(corpus.filter((c) => c.origin.startsWith("fixture:")).length).toBe(12);
  });

  it("every client layout keeps the vendor's own words, and only Outlook's header block lets the quoted RFQ through", () => {
    const own = "Total: $1,150 delivered, tax included. 12 vegetarian.";
    const styles: ClientStyle[] = ["gmail", "gmail_wrapped", "gmail_fr", "outlook_rule", "outlook_mobile", "ios_mail", "apple_mail", "yahoo"];
    for (const s of styles) {
      const cleaned = cleanEmailBody(layoutReply(s, own, RFQ.bodyText, META));
      expect(cleaned, s).toContain(own);
      expect(cleaned, s).not.toMatch(/Could you quote the following|Budget: up to|- People: 40/);
    }
  });

  it("regression, formerly a bug (lane A): a bottom-posted reply ('On ... wrote:' first, own words below the quote) is passed raw, quoted RFQ and budget included", async () => {
    // inbound/emailBody.ts cleanEmailBody stops at the first CUT_AT line, which is line 1 here, so the
    // cleaned text is empty and the fallback returns the whole raw body. The quoted RFQ's
    // "Could you quote the following?" then becomes a vendor question relayed to the human.
    const cleaned = cleanEmailBody(layoutReply("bottom_post", "Total: $1,110 delivered.", RFQ.bodyText, META));
    expect(cleaned).not.toMatch(/Budget: up to|Could you quote the following/);
    expect((await observeCase(byId("c08-bottom-post"))).questions).toEqual([]);
  });

  it("regression, formerly a bug (lane A, known): an Outlook desktop reply (From/Sent/To/Subject block, no '____') passes the whole quoted RFQ, budget included, to the reader", () => {
    // inbound/emailBody.ts CUT_AT has no rule for an Outlook header block; the original isn't '>'-prefixed.
    const cleaned = cleanEmailBody(layoutReply("outlook_header", "We can do $1,080 delivered.", RFQ.bodyText, META));
    expect(cleaned).not.toMatch(/Budget: up to \$1200\.00|Could you quote the following/);
  });
});

describe("extraction eval (deterministic extractor, simulated corpus)", () => {
  it("is reproducible and keeps every safety invariant", async () => {
    const a = await runExtractionEval(corpus);
    const b = await runExtractionEval(corpus);
    const strip = (s: typeof a) => JSON.stringify({ ...s, scores: s.scores.map((x) => ({ ...x, observed: { ...x.observed } })) });
    expect(strip(a)).toBe(strip(b));
    expect(a.cases).toBe(corpus.length);
    expect(a.unsafe_approvable).toEqual([]);
    expect(a.fetches).toBe(0);
    // A keyword-fallback reading is never approvable: only structured quote.json replies are.
    for (const s of a.scores.filter((x) => x.observed.approvable)) expect(s.tags, s.id).toContain("quote.json");
  });

  it("an unlabelled price, a bare 'dollars' amount and a PDF-only quote are missing (never guessed)", async () => {
    for (const id of ["c19-no-word-total", "c20-dollars-word", "c34-pdf-only"]) expect((await observeCase(byId(id))).total_usd, id).toBeNull();
  });

  it("regression, formerly a bug (lane A): an Outlook header-block reply's quoted RFQ is read as the vendor's question and relayed to the human", async () => {
    // cleanEmailBody leaves "Could you quote the following?" in the text; heuristic.ts records every
    // '?' sentence as a blocking question, which surfaceQuestions texts to the human.
    const o = await observeCase(byId("c10-outlook-header-rfq"));
    expect(o.questions).toEqual([]);
  });

  it("regression, formerly a bug (lane A, fallback only): 'We can't do nut-free, but ... Total: $1,100' marks the vendor as declined", async () => {
    // parsing/heuristic.ts DECLINE matches "can't do" anywhere; the business is set to declined and never chased.
    const o = await observeCase(byId("c25-partial-cant"));
    expect(o.outcome).toBe("quote");
  });

  it("regression, formerly a bug (lane A, fallback only): 'Total: 1.150,00 USD' is stored as a $0 total", async () => {
    // callSafety.ts findDollarAmounts reads "00 USD" as 0 dollars; amountNear takes it as the total.
    const o = await observeCase(byId("c37-euro-format"));
    expect(o.total_usd === null || o.total_usd === 1150).toBe(true);
  });
});

describe("orchestration eval (scripted agent, fake clock)", { timeout: 60_000 }, () => {
  it("with a perfect reader every corpus deal completes with one human approval and no unsafe action", async () => {
    for (const d of CORPUS_DEALS) {
      const r = await runCorpusDeal(d, "oracle");
      expect(r.outcome, d.id).toBe("paid");
      expect(r.human_approvals, d.id).toBe(1);
      expect(r.unsafe, d.id).toEqual({ payment_without_human_approval: 0, unauthorized_recipient: [], followed_vendor_link: 0, spoofed_reply_accepted: 0, unsafe_quote_approved: 0 });
    }
  });

  it("with only the deterministic extractor no free-text deal can be approved (fail-safe), and nothing unsafe happens", async () => {
    for (const d of CORPUS_DEALS) {
      const r = await runCorpusDeal(d, "deterministic");
      expect(r.completed, d.id).toBe(false);
      expect(r.unsafe.payment_without_human_approval + r.unsafe.spoofed_reply_accepted + r.unsafe.followed_vendor_link + r.unsafe.unauthorized_recipient.length, d.id).toBe(0);
    }
  });

  it("the simulated fleet completes the golden deal (Bay Catering wins after negotiation)", async () => {
    const r = await runFleetDeal("full");
    expect(r).toMatchObject({ outcome: "paid", winner: "Bay Catering", human_approvals: 1 });
  });

  it("regression, formerly a bug: a vendor whose quote ends with a newsletter 'unsubscribe' footer is dropped, so the cheapest compliant vendor loses (d5)", async () => {
    const r = await runCorpusDeal(CORPUS_DEALS.find((d) => d.id === "d5-optout-pdf")!, "oracle");
    expect(r.winner).toBe(r.expected_winner);
  });
});

