// A demo can go wrong: one vendor declines, one never answers, one replies without a price, one quotes.
// Haggle must stay useful and truthful: finish the deal on its deadline, recommend only the real quote,
// never invent a total for the vague reply, say who declined and who went silent, and contact nobody
// it wasn't asked to (no substitutes). No network.
import { describe, expect, it } from "vitest";
import { createMockEngine, type Persona } from "../src/index.ts";
import type { QuoteExtraction } from "../src/parsing/extraction.ts";

const base: QuoteExtraction = {
  available: true, price_per_head_usd: null, headcount: 40, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true,
  total_usd: null, deposit_usd: null, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }], valid_until: "2030-01-09",
  questions: [], payment_request: "none", instructions_to_agent: false, sources: [], missing_fields: [], confidence: 0.9,
};
const PERSONAS: Persona[] = [
  { name: "Steady Kitchen", email: "steady@sim.haggle.dev", delayMs: 1_000, reply: (t) => (t === "rfq" ? { text: "$1,000 total delivered, $100 deposit.", extraction: { ...base, total_usd: 1000, deposit_usd: 100, sources: [{ field: "total", source: "email body", excerpt: "$1,000 total" }, { field: "deposit", source: "email body", excerpt: "$100 deposit" }] } } : null) },
  { name: "Booked Bistro", email: "booked@sim.haggle.dev", delayMs: 1_000, reply: (t) => (t === "rfq" ? { text: "Sorry, we're fully booked that day.", extraction: { ...base, available: false } } : null) },
  { name: "Silent Catering", email: "silent@sim.haggle.dev", delayMs: 1_000, reply: () => null },
  { name: "Vague Eats", email: "vague@sim.haggle.dev", delayMs: 1_000, reply: (t) => (t === "rfq" || t === "followup" ? { text: "We can probably do it, should be reasonable!", extraction: { ...base, missing_fields: ["total"] } } : null) },
];

describe("a rough demo: decline, silence, a reply without a price, one real quote", { timeout: 60_000 }, () => {
  it("finishes on its deadline, recommends only the real quote, invents nothing, contacts no substitutes", async () => {
    let t = Date.now();
    const { engine } = createMockEngine({ now: () => new Date(t), personas: PERSONAS });
    const deal = await engine.deal({
      request: { what: "lunch catering", quantity: 40, date: "2030-01-10", area: "San Francisco, CA", requirements: [{ id: "veg12", kind: "dietary", text: "At least 12 vegetarian meals", hard: true, min_count: 12 }] },
      budget_usd: 1200, businesses: PERSONAS.map((p) => ({ name: p.name, email: p.email, simulated: true })),
    });
    let cursor = 0;
    let board = await engine.getQuotes(deal.job_id);
    for (let i = 0; i < 300 && !board.ready; i++) {
      t += 30_000; // past follow-up and reply-by deadlines
      cursor = Number((await engine.waitForUpdate(deal.job_id, cursor, 0)).cursor);
      board = await engine.getQuotes(deal.job_id);
    }
    expect(board.ready).toBe(true);
    // Exactly the four businesses asked; nobody else was added.
    expect(board.businesses.map((b) => b.name).sort()).toEqual(PERSONAS.map((p) => p.name).sort());
    const by = (n: string) => board.businesses.find((b) => b.name === n)!;
    const stage = (n: string) => board.stages![by(n).business_id]!.stage;
    // The only priced quote is the recommendation; the vague reply has no total and can't win.
    const steady = board.quotes.find((q) => q.business === "Steady Kitchen")!;
    expect(board.recommended_quote_id).toBe(steady.quote_id);
    const vague = board.quotes.find((q) => q.business === "Vague Eats");
    if (vague) {
      expect(vague.total_usd).toBeNull();
      expect(vague.eligible).toBe(false);
    }
    expect(board.quotes.filter((q) => q.total_usd !== null).map((q) => q.business)).toEqual(["Steady Kitchen"]);
    // Statuses say what happened.
    expect(stage("Booked Bistro")).toBe("declined");
    expect(stage("Silent Catering")).toBe("no_reply");
    expect(by("Steady Kitchen").status).toBe("quoted");
    // Approving and paying are only possible for the real quote.
    const a = await engine.requestApproval(deal.job_id, steady.quote_id, "simulated");
    expect(a.payment_cents).toBe(10_000);
    if (vague) await expect(engine.requestApproval(deal.job_id, vague.quote_id, "simulated")).rejects.toBeTruthy();
  });
});
