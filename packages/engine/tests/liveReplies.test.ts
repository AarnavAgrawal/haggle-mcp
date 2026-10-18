// P0 2026-10-18 rehearsal: three real replies ("$1500, $250 deposit" by text, "prolly around 1300 total
// bucks" by email, "approximately twelve hundred dollars" on a call) never became quotes: every live
// parse failed ("compiled grammar is too large"). These are the real Claude extractions of those exact
// replies with the split schema (scripts/acceptance/extract-eval.mts); the engine must turn them into
// quotes, show what is missing, and move on to comparison and negotiation by itself (clock only).
import { afterAll, describe, expect, it } from "vitest";
import { createMockEngine, PostgresRepository, type Persona } from "../src/index.ts";
import live from "./fixtures/live-replies-2026-10-18.json" with { type: "json" };

const R = Object.fromEntries(live.replies.map((r) => [r.business, r]));
const PERSONAS: Persona[] = [
  { name: "Sunset Kitchen", email: "events@sunset.sim.haggle.dev", delayMs: 1_000, reply: (t) => (t === "rfq" ? { text: R["Sunset Kitchen"]!.text, extraction: R["Sunset Kitchen"]!.extraction as never } : null) },
  { name: "Harbor Table", email: "orders@harbor.sim.haggle.dev", delayMs: 1_000, reply: (t) => (t === "rfq" ? { text: R["Harbor Table"]!.text, extraction: R["Harbor Table"]!.extraction as never } : null) },
  { name: "Mission Eats", email: "", phone: "+14155550104", delayMs: 1_000, reply: (t) => (t === "call" ? { text: R["Mission Eats"]!.text, extraction: R["Mission Eats"]!.extraction as never } : null) },
];

// Also on Postgres with the production migrations (the CHECK constraints behind two outages are enforced there).
const PG_URL = process.env.HAGGLE_TEST_DATABASE_URL;
const repos: PostgresRepository[] = [];
afterAll(async () => { await Promise.all(repos.map((r) => r.close())); });

describe.each(PG_URL ? ["memory", "postgres"] : ["memory"])("the live rehearsal replies become quotes and the deal moves on by itself (%s)", { timeout: 120_000 }, (backend) => {
  it("three quotes from the vendors' own words, missing details shown, counters citing 'about $1,200', then an approvable recommendation", async () => {
    let t = Date.now();
    const repo = backend === "postgres" ? (repos.push(new PostgresRepository(PG_URL!, { max: 2 })), repos.at(-1)!) : undefined;
    const { engine, fleet } = createMockEngine({ now: () => new Date(t), personas: PERSONAS, config: { maxRounds: 3, mode: "live" }, ...(repo ? { repo } : {}) });
    const deal = await engine.deal({ request: { what: "catering", quantity: 50, unit: "people", date: "2030-10-24", area: "San Francisco, CA", requirements: [] }, businesses: PERSONAS.map((p) => ({ name: p.name, ...(p.email ? { email: p.email } : {}), ...(p.phone ? { phone: p.phone } : {}), simulated: true })) });
    let b = await engine.getQuotes(deal.job_id);
    for (let i = 0; i < 400 && !b.ready; i++) {
      t += 15_000;
      await fleet.deliverDue(); // the vendors' replies arriving (webhooks, live)
      await engine.advanceJob(deal.job_id); // the live background tick: no buyer tool call
      b = await engine.getQuotes(deal.job_id);
    }
    const q = (n: string) => b.quotes.find((x) => x.business === n)!;
    // Quotes, exactly as stated: nothing invented (no tax, delivery or deposit that wasn't said).
    expect(q("Sunset Kitchen")).toMatchObject({ total_usd: 1500, deposit_usd: 250 });
    expect(q("Harbor Table")).toMatchObject({ total_usd: 1300 });
    expect(q("Harbor Table").deposit_usd).toBeUndefined();
    expect(q("Mission Eats")).toMatchObject({ total_usd: 1200 });
    expect(q("Mission Eats").deposit_usd).toBeUndefined();
    // What wasn't said is shown, and a vague reply is marked as such.
    expect(b.quotes.every((x) => x.flags.includes("delivery_unclear"))).toBe(true);
    expect(q("Harbor Table").flags).toContain("low_confidence");
    // "prolly around 1300" and "approximately twelve hundred" are estimates: shown ≈ and ranked, never approvable.
    expect(q("Harbor Table")).toMatchObject({ total_approximate: true, approvable: false, approval_block: { code: "total_not_firm" } });
    expect(q("Mission Eats")).toMatchObject({ total_approximate: true, approvable: false, approval_block: { code: "total_not_firm" } });
    expect(q("Sunset Kitchen")).toMatchObject({ approvable: true });
    // It moved on by itself: counters cite Mission Eats' $1,200 as what it is, an estimate ("about").
    expect(b.negotiation.map((n) => [n.business, n.target_total_usd, n.basis_approximate]).sort()).toEqual([["Harbor Table", 1200, true], ["Sunset Kitchen", 1200, true]]);
    expect(b.ready).toBe(true);
    // Best value is still Mission Eats, but only an approvable quote is recommended; the board says why.
    expect(b.best_value_quote_id).toBe(q("Mission Eats").quote_id);
    expect(b.recommended_quote_id).toBe(q("Sunset Kitchen").quote_id);
    // list_deals' "leading" is the board's recommendation, never the cheaper estimate ("≈ $1,200").
    const listed = (await engine.recentDeals(5)).find((d) => d.job_id === deal.job_id)!;
    expect(listed.leading).toMatchObject({ business: "Sunset Kitchen" });
    expect(b.recommendation_note).toMatch(/^Best value is Mission Eats but it can't be approved yet: Approximate total from the call \(≈ \$1,200\)\..*callback/);
    expect(b.next).toMatch(new RegExp(`approve\\(job_id, quote_id='${q("Sunset Kitchen").quote_id}'\\) for Sunset Kitchen`));
  });
});
