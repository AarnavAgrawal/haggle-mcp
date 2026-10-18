// Ported from quote-broker@8a68559 tests/counteroffer.test.ts (Partner), adapted to totals,
// compliance/trust filtering, basis quote ids and round caps (Haggle v3 golden scenario).
import { describe, expect, it } from "vitest";
import { planCounteroffers, type CounterQuote } from "../src/negotiation/counteroffer.ts";

const DEADLINE = new Date("2026-10-17T21:30:00Z");
const q = (over: Partial<CounterQuote> & Pick<CounterQuote, "quoteId" | "businessId" | "businessName">): CounterQuote => ({
  totalCents: null, available: true, compliant: true, senderTrusted: true, round: 1, status: "current", confidence: 0.9, flags: [], ...over,
});
const round1: CounterQuote[] = [
  q({ quoteId: "q-bay-1", businessId: "b-bay", businessName: "Bay Catering", totalCents: 115000 }),
  q({ quoteId: "q-harbor-1", businessId: "b-harbor", businessName: "Harbor Table", totalCents: 112000 }),
  q({ quoteId: "q-sunset-1", businessId: "b-sunset", businessName: "Sunset Kitchen", totalCents: 118000 }),
  q({ quoteId: "q-grill-1", businessId: "b-grill", businessName: "Golden Grill", totalCents: 86000, compliant: false }),
  q({ quoteId: "q-deli-1", businessId: "b-deli", businessName: "QuickQuote Deli", totalCents: 70000, senderTrusted: false }),
  q({ quoteId: "q-mission-1", businessId: "b-mission", businessName: "Mission Eats", totalCents: null }),
];

const figures = (text: string) => [...text.matchAll(/\$([\d,]+\.\d{2})/g)].map((m) => Math.round(Number(m[1]!.replace(/,/g, "")) * 100));

describe("planCounteroffers", () => {
  const plan = planCounteroffers(round1, DEADLINE);

  it("cites the best compliant, trusted quote, never the cheaper non-compliant or untrusted ones", () => {
    for (const p of plan) {
      expect(p.targetTotalCents).toBe(112000);
      expect(p.basisQuoteId).toBe("q-harbor-1");
    }
  });

  it("counters only eligible businesses priced above the best", () => {
    expect(plan.map((p) => p.businessId).sort()).toEqual(["b-bay", "b-sunset"]);
  });

  it("every dollar figure in the text is a stored, safe quote total", () => {
    const stored = new Set(round1.filter((x) => x.senderTrusted && x.totalCents !== null).map((x) => x.totalCents));
    for (const p of plan) {
      const f = figures(p.text);
      expect(f).toEqual([p.theirTotalCents, p.targetTotalCents]);
      for (const cents of f) expect(stored.has(cents)).toBe(true);
    }
  });

  it("never names any other business", () => {
    for (const p of plan) for (const x of round1) if (x.businessId !== p.businessId) expect(p.text).not.toContain(x.businessName);
  });

  it("greets the business by name, opens round 2, and states the deadline", () => {
    const bay = plan.find((p) => p.businessId === "b-bay")!;
    expect(bay.text).toMatch(/^Hi Bay Catering,/);
    expect(bay.text).toContain("$1,150.00 total");
    expect(bay.text).toContain("21:30 UTC");
    expect(bay.round).toBe(2);
  });

  it("after Bay's real $995 revision, Harbor is countered with Bay's quote as the basis", () => {
    const round2 = round1.map((x) => (x.businessId === "b-bay" ? { ...x, quoteId: "q-bay-2", totalCents: 99500, round: 2 } : x));
    const harbor = planCounteroffers(round2, DEADLINE).find((p) => p.businessId === "b-harbor")!;
    expect(harbor).toMatchObject({ targetTotalCents: 99500, basisQuoteId: "q-bay-2", theirTotalCents: 112000 });
  });

  it("never cites a flagged scam or injection quote, even when it is cheapest and authenticated", () => {
    const withScam = [...round1, q({ quoteId: "q-scam", businessId: "b-scam", businessName: "Scam Co", totalCents: 50000, flags: ["external_payment_link"] })];
    for (const p of planCounteroffers(withScam, DEADLINE)) expect(p.basisQuoteId).toBe("q-harbor-1");
    const withInjection = [...round1, q({ quoteId: "q-inj", businessId: "b-inj", businessName: "Inj Co", totalCents: 50000, flags: ["prompt_injection"] })];
    for (const p of planCounteroffers(withInjection, DEADLINE)) expect(p.basisQuoteId).toBe("q-harbor-1");
  });

  it("never cites a superseded revision; an over-budget quote is still real and is negotiated", () => {
    const stale = [...round1, q({ quoteId: "q-old", businessId: "b-old", businessName: "Old", totalCents: 50000, status: "superseded" })];
    for (const p of planCounteroffers(stale, DEADLINE)) expect(p.basisQuoteId).toBe("q-harbor-1");
    expect(planCounteroffers(round1, DEADLINE, 2, 111000).map((p) => p.businessId).sort()).toEqual(["b-bay", "b-sunset"]);
  });

  it("counters a business that misses a requirement too, citing a quote that meets them", () => {
    const pricey = [...round1.slice(0, 3), q({ quoteId: "q-grill-2", businessId: "b-grill", businessName: "Golden Grill", totalCents: 130000, compliant: false })];
    const grill = planCounteroffers(pricey, DEADLINE).find((p) => p.businessId === "b-grill")!;
    expect(grill).toMatchObject({ basisQuoteId: "q-harbor-1", targetTotalCents: 112000 });
  });

  it("when no quote is confirmed to meet every requirement it still negotiates, without claiming the same requirements", () => {
    const unconfirmed = [
      q({ quoteId: "q-a", businessId: "b-a", businessName: "Mission Eats", totalCents: 176000, compliant: false, unmet: false }),
      q({ quoteId: "q-b", businessId: "b-b", businessName: "Sunset Kitchen", totalCents: 302500, compliant: false, unmet: false }),
    ];
    const plan = planCounteroffers(unconfirmed, DEADLINE, 2, 150000);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ businessId: "b-b", basisQuoteId: "q-a", targetTotalCents: 176000 });
    expect(plan[0]!.text).toContain("for the same order.");
    expect(plan[0]!.text).not.toContain("requirements");
  });

  it("stops at the round cap", () => {
    const capped = round1.map((x) => ({ ...x, round: 2 }));
    expect(planCounteroffers(capped, DEADLINE, 2)).toEqual([]);
  });

  it("sends nothing with fewer than 2 eligible quotes", () => {
    expect(planCounteroffers(round1.slice(0, 1), DEADLINE)).toEqual([]);
    expect(planCounteroffers([round1[0]!, round1[3]!, round1[4]!, round1[5]!], DEADLINE)).toEqual([]);
  });

  it("does not counter a business tied with the best total", () => {
    const tied = [round1[1]!, { ...round1[0]!, totalCents: 112000 }];
    expect(planCounteroffers(tied, DEADLINE)).toEqual([]);
  });
});
