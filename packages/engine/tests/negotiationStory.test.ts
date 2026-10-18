// The negotiation story must be measured from firm prices. Harbor Table said "prolly around 1300",
// confirmed a firm $1,250 when asked, then held at $1,250 when countered: that is a clarification and
// then holding firm, never "lowered their price by $50" (an estimate is not a starting price).
import { describe, expect, it } from "vitest";
import { createMockEngine, type Persona } from "../src/index.ts";
import live from "./fixtures/live-replies-2026-10-18.json" with { type: "json" };

const R = Object.fromEntries(live.replies.map((r) => [r.business, r]));
const firm = (total: number, deposit: number, excerpt: string) => ({ ...(R["Sunset Kitchen"]!.extraction as object), total_usd: total, deposit_usd: deposit, confidence: 0.9, sources: [{ field: "total", source: "email body", excerpt }, { field: "deposit", source: "email body", excerpt: `$${deposit} deposit` }] });
const PERSONAS: Persona[] = [
  { name: "Harbor Table", email: "orders@harbor.sim.haggle.dev", delayMs: 1_000, reply: (t) =>
    t === "rfq" ? { text: R["Harbor Table"]!.text, extraction: R["Harbor Table"]!.extraction as never }
    : t === "followup" ? { text: "Firm: $1,250 all in, $200 deposit.", extraction: firm(1250, 200, "$1,250 all in") as never }
    : t === "counter" ? { text: "Best we can do is $1,250, sorry.", extraction: firm(1250, 200, "$1,250") as never } : null },
  { name: "Steady Kitchen", email: "steady@sim.haggle.dev", delayMs: 1_000, reply: (t) => (t === "rfq" ? { text: "$1,100 total, $100 deposit.", extraction: firm(1100, 100, "$1,100 total") as never } : null) },
];

describe("negotiation story from firm prices", { timeout: 60_000 }, () => {
  it("estimate → firm clarification → held at the firm price: held firm, no saving, starting price is the firm one", async () => {
    let t = Date.now();
    const { engine, fleet } = createMockEngine({ now: () => new Date(t), personas: PERSONAS });
    const deal = await engine.deal({ request: { what: "catering", quantity: 50, unit: "people", date: "2030-10-24", area: "San Francisco, CA", requirements: [] }, businesses: PERSONAS.map((p) => ({ name: p.name, email: p.email, simulated: true })) });
    let b = await engine.getQuotes(deal.job_id);
    for (let i = 0; i < 400 && !b.ready; i++) { t += 15_000; await fleet.deliverDue(); await engine.advanceJob(deal.job_id); b = await engine.getQuotes(deal.job_id); }
    const harbor = b.businesses.find((x) => x.name === "Harbor Table")!;
    const st = b.stages![harbor.business_id]!;
    expect(b.negotiation.some((n) => n.business === "Harbor Table" && n.outcome_total_usd === 1250)).toBe(true); // it was countered and answered
    expect(st).toMatchObject({ negotiation: "held_firm", first_total_usd: 1250, current_total_usd: 1250 });
    expect(st.saved_usd).toBeUndefined();
    expect(b.quotes.find((q) => q.business === "Harbor Table")!.negotiated_from).toBeUndefined();
  });
});
