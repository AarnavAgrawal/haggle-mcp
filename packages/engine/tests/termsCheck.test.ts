// parsing/termsCheck.ts: a perfectly read price is still the wrong offer for another date, a delivery
// window that misses the requested time, or a reply written as a different business. Flagged
// (date_mismatch, delivery_window_mismatch, identity_mismatch) and never approvable or recommended.
// Plus the keyword reader: "Total … plus X% tax" is tax_excluded, a gratuity added on top is fees_unclear.
// Wordings from E's f2 corpus (c38, c39, c42, c43, c46). Real engine, fakes, no network.
import { describe, expect, it } from "vitest";
import { termsMismatch } from "../src/parsing/termsCheck.ts";
import { heuristicExtract } from "../src/parsing/heuristic.ts";
import { validateQuote } from "../src/parsing/validate.ts";
import type { ExtractorPort } from "../src/workflow/ports.ts";
import { replyToken } from "../src/inbound/senderAuth.ts";
import { liveEngine, TOKEN_SECRET, vendorReply } from "./helpers/liveEngine.ts";

const REQ = { date: "2026-10-29", time: "12:00" };
const check = (own: string, businessName = "Laurel Village Deli", x: object = {}) => termsMismatch({ own, x, request: REQ, businessName });

describe("termsMismatch (pure)", () => {
  it("another date offered: c43", () => {
    const r = check("We're booked on the 29th, but we can do Friday the 30th: Total $1,000 delivered, tax included, 12 vegetarian.");
    expect(r.flags).toEqual(["date_mismatch"]);
    expect(r.offered_date).toBe("2026-10-30");
    expect(check("How about Oct 31 instead? $1,000 total.").offered_date).toBe("2026-10-31");
    expect(check("We could do Saturday. $1,000 total.").offered_date).toBe("2026-10-31");
  });
  it("the requested date, dates that aren't an offer, and a flexible range are fine", () => {
    for (const t of [
      "We can do the 29th! $1,000 total.", "Yes we can do it: $1,000 total. Deposit due by the 25th.", "We can do Thursday, $1,000 total.",
      "Quote valid until Nov 5. We can cater it for $1,000.", "We can do the 29th, deposit by the 22nd.", "$1,000 total, delivered.",
    ]) expect(check(t).flags, t).toEqual([]);
    expect(termsMismatch({ own: "We can do the 30th.", x: {}, request: { date: "2026-10-29", date_until: "2026-10-31" }, businessName: "X Deli" }).flags).toEqual([]);
  });
  it("delivery window that misses the requested time: c42", () => {
    const r = check("Total: $1,080 delivered, tax included, 12 vegetarian. Heads up: our drivers only deliver between 9:00 and 10:30 AM.");
    expect(r.flags).toEqual(["delivery_window_mismatch"]);
    expect(r.delivery_window).toBe("09:00-10:30");
    expect(check("We deliver between 11:00 and 11:45 AM. $1,000 total.").flags).toEqual([]);
    expect(check("Delivery from 1 to 2 pm only.").flags).toEqual(["delivery_window_mismatch"]);
    expect(termsMismatch({ own: "", x: { delivery_window: { start: "09:00", end: "10:30" } }, request: REQ, businessName: "X Deli" }).flags).toEqual(["delivery_window_mismatch"]);
  });
  it("written as another business: c46; a person's name or the business's own name is fine", () => {
    const r = check("Hi, this is Golden Gate Grill (we share this inbox with Harborview Catering). Total: $990 delivered, tax included, 12 vegetarian.\n\nGolden Gate Grill", "Harborview Catering");
    expect(r.flags).toEqual(["identity_mismatch"]);
    expect(r.signed_as).toBe("Golden Gate Grill");
    for (const t of ["$990 total.\n\nThanks,\nMaria\nHarborview Catering", "$990 total.\n\nMaria", "Hi, this is Maria from Harborview. $990 total.", "$990 total.\n\n-- \nHarborview Catering Co.", "We are happy to help! $990 total."]) expect(check(t, "Harborview Catering").flags, t).toEqual([]);
    expect(termsMismatch({ own: "", x: { signed_as: "Maria" }, request: REQ, businessName: "Harborview Catering" }).flags).toEqual([]);
    expect(termsMismatch({ own: "", x: { signed_as: "Golden Gate Grill" }, request: REQ, businessName: "Harborview Catering" }).flags).toEqual(["identity_mismatch"]);
  });
});

describe("keyword reader: tax on top and gratuity (c38, c39)", () => {
  const req = { what: "lunch", location: "SF", dietary: [{ need: "vegetarian", count: 12 }], requirements: [] } as never;
  it("'Total: $1,050 delivered, plus 8.625% sales tax' is never a firm all-in total", () => {
    const x = heuristicExtract({ request: req, bodyText: "Total: $1,050 delivered, plus 8.625% sales tax. 12 vegetarian." });
    expect(x.tax_included).toBe(false);
    expect(validateQuote(x, 40).flags).toContain("tax_excluded");
    expect(heuristicExtract({ request: req, bodyText: "Total: $1,050 delivered, tax included." }).tax_included).toBe(true);
  });
  it("a 20% gratuity added on top is kept as an unclear fee, never dropped", () => {
    const x = heuristicExtract({ request: req, bodyText: "Total: $1,000 delivered, tax included, 12 vegetarian. A 20% gratuity ($200) is added to all event orders." });
    expect(x.other_fees).toEqual([expect.objectContaining({ label: "gratuity", amount_usd: 200, included_in_total: null })]);
    expect(validateQuote(x, 40).flags).toContain("fees_unclear");
    expect(heuristicExtract({ request: req, bodyText: "Total $1,000. Gratuity is up to you." }).other_fees).toBeUndefined();
  });
});

describe("in the engine: flagged, not approvable, never recommended; the board's vendor_contact", () => {
  const reader: ExtractorPort = {
    async extract(i) {
      const m = i.bodyText.match(/total:?\s*\$\s?([\d,]+)/i);
      const total = m ? Number(m[1]!.replace(/,/g, "")) : null;
      return {
        available: true, price_per_head_usd: null, headcount: 40, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true, total_usd: total, deposit_usd: null,
        menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }], valid_until: null, questions: [], payment_request: "none", instructions_to_agent: false,
        sources: total !== null ? [{ field: "total", source: "email body", excerpt: m![0] }] : [], missing_fields: [], confidence: 0.95,
        requirement_checks: [{ requirement_id: "veg12", met: true, evidence: "12 vegetarian", note: "stated" }, { requirement_id: "delivery", met: true, evidence: "delivered", note: "stated" }],
      } as never;
    },
  };
  const cases = [
    { name: "Laurel Village Deli", email: "orders@laurel.example", own: "We're booked on the 29th, but we can do Friday the 30th: Total $1,000 delivered, tax included, 12 vegetarian.", code: "date_mismatch" },
    { name: "Bernal Heights Bakery", email: "orders@bernal.example", own: "Total: $1,080 delivered, tax included, 12 vegetarian. Heads up: our drivers only deliver between 9:00 and 10:30 AM.", code: "delivery_window_mismatch" },
    { name: "Harborview Catering", email: "orders@harborview.example", own: "Hi, this is Golden Gate Grill (we share this inbox with Harborview Catering). Total: $990 delivered, tax included, 12 vegetarian.\n\nGolden Gate Grill", code: "identity_mismatch" },
    { name: "Mission Eats", email: "orders@mission.example", own: "Total: $1,100 delivered, tax included, 12 vegetarian.\n\nMaria\nMission Eats", code: null },
  ];
  it("each mismatch blocks approval with its own code and reason; the clean quote is the one recommended", async () => {
    const env = liveEngine({ extractor: reader });
    const deal = await env.engine.deal({ request: { what: "lunch catering", quantity: 40, unit: "people", date: "2026-10-29", time: "12:00", area: "San Francisco, CA", requirements: [{ id: "veg12", kind: "dietary", text: "At least 12 vegetarian meals", hard: true, min_count: 12 }, { id: "delivery", kind: "delivery", text: "Delivery included", hard: true }] }, budget_usd: 1200, businesses: cases.map((c) => ({ name: c.name, email: c.email })) });
    const bs = await env.repo.getBusinesses(deal.job_id);
    for (const c of cases) {
      const b = bs.find((x) => x.email === c.email)!;
      expect((await vendorReply(env, b, replyToken(TOKEN_SECRET, deal.job_id, b.business_id), { bodyText: c.own })).outcome).toBe("stored");
    }
    await env.engine.advanceJob(deal.job_id);
    const board = await env.engine.getQuotes(deal.job_id);
    for (const c of cases) {
      const q = board.quotes.find((x) => x.business === c.name)!;
      if (c.code === null) {
        expect(q).toMatchObject({ approvable: true });
        expect(board.recommended_quote_id).toBe(q.quote_id);
      } else {
        expect(q.flags, c.name).toContain(c.code);
        expect(q, c.name).toMatchObject({ approvable: false, approval_block: { code: c.code } });
      }
    }
    expect(board.quotes.find((x) => x.business === "Laurel Village Deli")!.approval_block!.reason).toMatch(/2026-10-30, not the requested date/);
    // The board's vendor_contact read model (E's views.ts passes it through).
    expect(Object.values(board.vendor_contact!).map((v) => v.status)).toEqual(["replied", "replied", "replied", "replied"]);
  });
});
