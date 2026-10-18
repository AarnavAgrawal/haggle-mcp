// Best-value ranking: hard gates first (rank.ts), then explainable, deterministic value. No network.
import { describe, expect, it } from "vitest";
import { matchListing, nameSimilarity, normalizeWeights, placesReputation, reputationScore, scoreQuotes, type ReputationEvidence, type ValueInput } from "../src/index.ts";

const rep = (rating: number, review_count: number, match_confidence = 1): ReputationEvidence => ({ source: "Google Places", rating, review_count, matched_name: "x", match_confidence, fetched_at: "2026-10-18T00:00:00Z" });
const quote = (o: Partial<ValueInput> & { quoteId: string; totalCents: number }): ValueInput => ({
  businessId: `b_${o.quoteId}`, business: o.quoteId, depositCents: Math.round(o.totalCents * 0.2), deliveryIncluded: true, deliveryStated: true, taxStated: true, dietaryStated: true, itemsListed: true, confidence: 0.9,
  reputationStatus: "not_found", reliability: null, ...o,
});

describe("best value (deterministic, explainable)", () => {
  it("a more expensive, well-reviewed, fully specified vendor legitimately beats a cheaper, poorly reviewed, vague one", () => {
    const premium = quote({ quoteId: "premium", business: "Premium Kitchen", totalCents: 460_000, depositCents: 46_000, reputationStatus: "found", reputation: rep(4.8, 900) });
    const cheap = quote({ quoteId: "cheap", business: "Cheap Eats", totalCents: 420_000, depositCents: 210_000, deliveryIncluded: false, taxStated: false, dietaryStated: false, reputationStatus: "found", reputation: rep(3.1, 40) });
    const r = scoreQuotes([cheap, premium]);
    expect(r.recommendedQuoteId).toBe("premium");
    expect(r.ranked.map((x) => x.quoteId)).toEqual(["premium", "cheap"]);
    expect(r.explanation!.winner).toMatch(/^Premium Kitchen: best value 0\.\d\d — \$4,600, \$400 more than the cheapest eligible quote, but 4\.8★ from 900 Google Places reviews/);
    expect(r.explanation!.others[0]!.text).toMatch(/^Cheap Eats: \$400 cheaper \(\$4,200\), value 0\.\d\d vs 0\.\d\d; Premium Kitchen is ahead on reputation: 4\.8★/);
    // Every factor is shown with its evidence and weight.
    expect(r.ranked[0]!.factors.map((f) => f.name)).toEqual(["price", "reputation", "reliability", "completeness", "terms"]);
  });

  it("with equal quality the cheaper vendor wins, and a price-first buyer gets the cheapest", () => {
    const a = quote({ quoteId: "a", totalCents: 480_000 });
    const b = quote({ quoteId: "b", totalCents: 450_000 });
    expect(scoreQuotes([a, b]).recommendedQuoteId).toBe("b");
    const premium = quote({ quoteId: "premium", totalCents: 460_000, reputationStatus: "found", reputation: rep(4.9, 2000) });
    const cheap = quote({ quoteId: "cheap", totalCents: 420_000, reputationStatus: "found", reputation: rep(3.6, 300) });
    expect(scoreQuotes([premium, cheap], { price: 1, reputation: 0, reliability: 0, completeness: 0, terms: 0 }).recommendedQuoteId).toBe("cheap");
  });

  it("missing reputation is neutral, never a penalty; fictional demo vendors are never rated", () => {
    const listedAverage = quote({ quoteId: "listed", totalCents: 450_000, reputationStatus: "found", reputation: rep(4.0, 500) });
    const unlisted = quote({ quoteId: "unlisted", totalCents: 450_000, reputationStatus: "not_found" });
    const r = scoreQuotes([listedAverage, unlisted]);
    expect(r.ranked[0]!.score).toBe(r.ranked[1]!.score); // a 4.0★ listing scores like no listing
    const demo = quote({ quoteId: "demo", totalCents: 450_000, reputationStatus: "simulated", reputation: rep(5, 10_000) });
    const f = scoreQuotes([demo]).ranked[0]!.factors.find((x) => x.name === "reputation")!;
    expect(f).toMatchObject({ score: 0.5, neutral: true, note: "demo vendor: no public listing to check (neutral)" });
  });

  it("few reviews or an unsure listing match pull a rating toward neutral", () => {
    expect(reputationScore(rep(5, 3))).toBeLessThan(reputationScore(rep(5, 300)));
    expect(reputationScore(rep(5, 300, 0.6))).toBeLessThan(reputationScore(rep(5, 300, 1)));
    expect(reputationScore(rep(2, 500, 0))).toBe(0.5);
  });

  it("is deterministic; exact ties go to the lower total; negotiation shows in the explanation", () => {
    const x = [quote({ quoteId: "q2", totalCents: 300_000, negotiatedFromCents: 330_000 }), quote({ quoteId: "q1", totalCents: 310_000 })];
    expect(scoreQuotes(x)).toEqual(scoreQuotes([...x].reverse()));
    expect(scoreQuotes(x).explanation!.winner).toMatch(/lowest all-in total \$3,000 \(negotiated down from \$3,300\)/);
    expect(normalizeWeights({ price: 2, reputation: 2, reliability: 0, completeness: 0, terms: 0 })).toEqual({ price: 0.5, reputation: 0.5, reliability: 0, completeness: 0, terms: 0 });
    expect(normalizeWeights({ price: -1, reputation: 0, reliability: 0, completeness: 0, terms: 0 })).toEqual(normalizeWeights());
  });
});

describe("public reputation lookup (Google Places, non-blocking, attributed)", () => {
  it("matches by phone, else by name; an unsure match is 'ambiguous', no rating is 'not_found'", () => {
    const biz = { business_id: "b", name: "Harbor Table Catering", phone: "+14155550134", area: "San Francisco", simulated: false };
    expect(matchListing(biz, [{ displayName: { text: "HT Events" }, rating: 4.6, userRatingCount: 210, internationalPhoneNumber: "+1 415-555-0134" }])).toMatchObject({ status: "found", evidence: { rating: 4.6, review_count: 210, match_confidence: 1, source: "Google Places" } });
    expect(matchListing(biz, [{ displayName: { text: "Harbor Table" }, rating: 4.2, userRatingCount: 80 }]).status).toBe("found");
    expect(matchListing(biz, [{ displayName: { text: "Golden Harbor Seafood Restaurant" }, rating: 4.9, userRatingCount: 3000 }]).status).toBe("ambiguous");
    expect(matchListing(biz, [{ displayName: { text: "Harbor Table" } }]).status).toBe("not_found");
    expect(nameSimilarity("Bay Catering", "Bay Catering Co")).toBe(1);
  });

  it("never looks up demo vendors, is off without a key, and returns 'pending' then the cached result", async () => {
    const calls: string[] = [];
    const port = placesReputation({ apiKey: "test", fetch: async (_u, init) => { calls.push(init.body); return { ok: true, status: 200, json: async () => ({ places: [{ displayName: { text: "Bay Catering" }, rating: 4.7, userRatingCount: 512 }] }) }; } });
    expect(port.peek({ business_id: "demo", name: "Bay Catering", simulated: true })).toEqual({ status: "simulated" });
    expect(placesReputation({}).peek({ business_id: "x", name: "Bay Catering", simulated: false })).toEqual({ status: "disabled" });
    expect(port.peek({ business_id: "real", name: "Bay Catering", area: "San Francisco", simulated: false })).toEqual({ status: "pending" });
    await new Promise((r) => setTimeout(r, 0));
    expect(port.peek({ business_id: "real", name: "Bay Catering", area: "San Francisco", simulated: false })).toMatchObject({ status: "found", evidence: { rating: 4.7, review_count: 512 } });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!)).toEqual({ textQuery: "Bay Catering, San Francisco", pageSize: 5 });
  });
});

describe("public discovery (Google Places): found is not authorized", () => {
  it("dedupes listings, scores service relevance and area, drops closed businesses; nothing without a key", async () => {
    const { resolveListings, placesDiscover } = await import("../src/index.ts");
    const found = resolveListings([
      { displayName: { text: "Bay Area Roofing Co" }, formattedAddress: "12 Main St, Oakland, CA", internationalPhoneNumber: "+1 510-555-0101", websiteUri: "https://bayroof.example", types: ["roofing_contractor"], rating: 4.6, userRatingCount: 212, businessStatus: "OPERATIONAL" },
      { displayName: { text: "Bay Area Roofing" }, formattedAddress: "12 Main St, Oakland, CA", nationalPhoneNumber: "(510) 555-0101", types: ["roofing_contractor"], businessStatus: "OPERATIONAL" },
      { displayName: { text: "Peak Pizza" }, formattedAddress: "9 Elm St, Oakland, CA", types: ["restaurant"], businessStatus: "OPERATIONAL" },
      { displayName: { text: "Shut Roofing" }, formattedAddress: "Oakland, CA", types: ["roofing_contractor"], businessStatus: "CLOSED_PERMANENTLY" },
      { displayName: { text: "Far Roofing" }, formattedAddress: "1 Rd, Fresno, CA", types: ["roofing_contractor"], businessStatus: "OPERATIONAL" },
    ], "roofing contractor", "Oakland, CA");
    expect(found.map((f) => f.name)).toEqual(["Bay Area Roofing Co", "Far Roofing", "Peak Pizza"]);
    expect(found[0]).toMatchObject({ merged_listings: 2, in_area: true, rating: 4.6, review_count: 212, source: "Google Places", relevance: 1 });
    expect(found.find((f) => f.name === "Far Roofing")).toMatchObject({ in_area: false });
    expect(found.find((f) => f.name === "Peak Pizza")!.relevance).toBeLessThan(found[0]!.relevance);
    expect(await placesDiscover({}, "roofing", "Oakland, CA")).toBeNull();
  });
});

describe("deposit tradeoff", () => {
  it("at the same price, the lower, safer deposit wins; a much cheaper quote still beats a slightly better deposit", () => {
    const low = quote({ quoteId: "low_deposit", totalCents: 450_000, depositCents: 45_000 });
    const high = quote({ quoteId: "high_deposit", totalCents: 450_000, depositCents: 225_000 });
    expect(scoreQuotes([high, low]).recommendedQuoteId).toBe("low_deposit");
    const cheap = quote({ quoteId: "cheap", totalCents: 380_000, depositCents: 114_000 }); // 30% deposit, $700 cheaper
    expect(scoreQuotes([low, cheap]).recommendedQuoteId).toBe("cheap");
  });
});
