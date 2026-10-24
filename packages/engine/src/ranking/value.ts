// PURE: explainable best-value ranking over quotes that already passed the hard gates.
//
// Order of decisions (never changed by this module):
//   1. Safety (rank.ts `rejectReason`): only eligible quotes are scored here; preferences are soft, so a
//      quote that misses one is scored too, in a lower tier (ValueInput.tier) that always ranks after.
//   2. Among eligible quotes, a weighted score of evidence-backed factors, each in [0, 1]:
//        price        cheapest all-in total / this all-in total (1 = cheapest)
//        reputation   public rating shrunk toward neutral by review count and by how surely the listing
//                     is this business; NO listing (or a fictional demo vendor) = neutral 0.5
//        reliability  Haggle's own track record with the business (past real quotes, reply speed,
//                     safety flags seen); no history = neutral 0.5
//        completeness how much of the quote is stated (total, deposit, delivery, tax, dietary counts, items)
//        terms        deposit share (lower is better) and delivery included
//   3. Deterministic: same evidence + weights → same ranking. Ties (within TIE) go to the lower total,
//      then the higher extraction confidence, then the quote id.
// Missing data is neutral, never a penalty; ratings are only ever what a source returned (with the
// source name and review count). The LLM extracts evidence and may phrase explanations; it never
// picks the winner.

export type FactorName = "price" | "reputation" | "reliability" | "completeness" | "terms";

export interface ValueWeights {
  price: number;
  reputation: number;
  reliability: number;
  completeness: number;
  terms: number;
}

export const DEFAULT_WEIGHTS: ValueWeights = { price: 0.5, reputation: 0.2, reliability: 0.1, completeness: 0.1, terms: 0.1 };

/** A rating as a public source reported it. Never constructed for fictional (simulated) businesses. */
export interface ReputationEvidence {
  source: string; // "Google Places", "Yelp"
  rating: number; // 0..5 as reported
  review_count: number;
  url?: string;
  matched_name: string;
  /** 0..1: how sure we are this listing is this business (name/phone/address match). */
  match_confidence: number;
  fetched_at: string;
}

export interface ReliabilityEvidence {
  past_quotes: number; // real quotes on other jobs (seed/sample data excluded)
  median_reply_minutes?: number;
  safety_flags_seen: number; // scam links / injected instructions seen before
}

export interface ValueInput {
  quoteId: string;
  businessId: string;
  business: string;
  totalCents: number; // all-in total as stated or computed from stated parts
  depositCents: number | null;
  deliveryIncluded: boolean | null;
  deliveryStated: boolean;
  taxStated: boolean;
  dietaryStated: boolean; // every requested dietary need has a stated count
  itemsListed: boolean;
  confidence: number; // extraction confidence 0..1
  /**
   * Soft-preference tier (decision 1: requirements and budget are soft): 0 = meets everything that
   * was asked; higher = misses more (rank.ts caveats). A lower tier always ranks first; the score
   * orders quotes within a tier. Absent = 0.
   */
  tier?: number;
  negotiatedFromCents?: number;
  reputation?: ReputationEvidence | null;
  /** "simulated" = a fictional demo vendor: reputation is never looked up. */
  reputationStatus?: "found" | "not_found" | "pending" | "simulated" | "disabled" | "ambiguous";
  reliability?: ReliabilityEvidence | null;
}

export interface Factor {
  name: FactorName;
  score: number; // 0..1
  weight: number;
  /** true when there was no evidence and the neutral 0.5 was used. */
  neutral: boolean;
  note: string;
}

export interface ValueScore {
  quoteId: string;
  businessId: string;
  business: string;
  totalCents: number;
  score: number; // 0..1, weighted sum
  confidence: number; // 0..1, how much of the score rests on evidence
  factors: Factor[];
}

export interface ValueRanking {
  method: "best_value";
  weights: ValueWeights;
  ranked: ValueScore[]; // best first
  recommendedQuoteId: string | null;
  /** Why the winner wins, and why each other eligible quote doesn't (deterministic templates). */
  explanation: { winner: string; others: { quote_id: string; text: string }[] } | null;
}

const TIE = 0.005;
const NEUTRAL = 0.5;
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const round = (x: number) => Math.round(x * 1000) / 1000;
const usd = (c: number) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/** Normalize buyer preferences into weights that sum to 1 (negative/NaN → 0; all zero → defaults). */
export function normalizeWeights(w: Partial<ValueWeights> = {}): ValueWeights {
  const merged = { ...DEFAULT_WEIGHTS, ...w };
  const keys = Object.keys(DEFAULT_WEIGHTS) as FactorName[];
  const clean = Object.fromEntries(keys.map((k) => [k, Number.isFinite(merged[k]) && merged[k] > 0 ? merged[k] : 0])) as unknown as ValueWeights;
  const sum = keys.reduce((a, k) => a + clean[k], 0);
  if (sum <= 0) return { ...DEFAULT_WEIGHTS };
  return Object.fromEntries(keys.map((k) => [k, round(clean[k] / sum)])) as unknown as ValueWeights;
}

/** Bayesian-shrunk rating mapped to 0..1 (3★ = 0, 5★ = 1), pulled to neutral by few reviews or an unsure match. */
export function reputationScore(r: ReputationEvidence): number {
  const PRIOR = 4.0; // a typical listed business
  const C = 20; // reviews worth of prior
  const shrunk = (PRIOR * C + r.rating * r.review_count) / (C + Math.max(0, r.review_count));
  const raw = clamp((shrunk - 3) / 2);
  return clamp(NEUTRAL + (raw - NEUTRAL) * clamp(r.match_confidence));
}

function reliabilityScore(r: ReliabilityEvidence): number {
  let s = NEUTRAL + 0.25 * Math.min(r.past_quotes, 4) / 4;
  if (r.median_reply_minutes !== undefined) s += r.median_reply_minutes <= 60 ? 0.15 : r.median_reply_minutes <= 240 ? 0.05 : -0.05;
  s -= 0.3 * Math.min(r.safety_flags_seen, 2);
  return clamp(s);
}

function reputationNote(q: ValueInput): string {
  switch (q.reputationStatus) {
    case "simulated": return "demo vendor: no public listing to check (neutral)";
    case "pending": return "checking public reviews… (neutral until found)";
    case "not_found": return "no public listing found (neutral)";
    case "ambiguous": return "listing match too uncertain to use (neutral)";
    case "disabled": return "no review source configured (neutral)";
    default: return "no reputation data (neutral)";
  }
}

export function scoreQuotes(quotes: ValueInput[], weights: Partial<ValueWeights> = {}): ValueRanking {
  const w = normalizeWeights(weights);
  if (quotes.length === 0) return { method: "best_value", weights: w, ranked: [], recommendedQuoteId: null, explanation: null };
  const cheapest = Math.min(...quotes.map((q) => q.totalCents));

  const ranked = quotes.map((q): ValueScore => {
    const factors: Factor[] = [];
    const price = q.totalCents > 0 ? clamp(cheapest / q.totalCents) : 1;
    factors.push({ name: "price", score: round(price), weight: w.price, neutral: false, note: q.totalCents === cheapest ? `lowest all-in total (${usd(q.totalCents)})` : `${usd(q.totalCents - cheapest)} more than the lowest eligible total` });

    const rep = q.reputation && q.reputationStatus === "found" ? q.reputation : null;
    factors.push(rep
      ? { name: "reputation", score: round(reputationScore(rep)), weight: w.reputation, neutral: false, note: `${rep.rating.toFixed(1)}★ from ${rep.review_count.toLocaleString("en-US")} ${rep.source} reviews${rep.match_confidence < 0.9 ? ` (listing match ${Math.round(rep.match_confidence * 100)}%)` : ""}` }
      : { name: "reputation", score: NEUTRAL, weight: w.reputation, neutral: true, note: reputationNote(q) });

    factors.push(q.reliability && (q.reliability.past_quotes > 0 || q.reliability.safety_flags_seen > 0)
      ? { name: "reliability", score: round(reliabilityScore(q.reliability)), weight: w.reliability, neutral: false, note: `${q.reliability.past_quotes} earlier quote${q.reliability.past_quotes === 1 ? "" : "s"} with Haggle${q.reliability.median_reply_minutes !== undefined ? `, replies in ${q.reliability.median_reply_minutes < 1 ? "under a minute" : `~${Math.round(q.reliability.median_reply_minutes)} min`}` : ""}${q.reliability.safety_flags_seen ? `, ${q.reliability.safety_flags_seen} safety flag(s) before` : ""}` }
      : { name: "reliability", score: NEUTRAL, weight: w.reliability, neutral: true, note: "no track record with Haggle yet (neutral)" });

    const stated = [true, q.depositCents !== null, q.deliveryStated, q.taxStated, q.dietaryStated, q.itemsListed];
    const missing = ["deposit", "delivery", "tax", "dietary counts", "items"].filter((_, i) => !stated[i + 1]);
    factors.push({ name: "completeness", score: round(stated.filter(Boolean).length / stated.length), weight: w.completeness, neutral: false, note: missing.length ? `not stated: ${missing.join(", ")}` : "every term stated" });

    const depositShare = q.depositCents === null ? null : q.totalCents > 0 ? q.depositCents / q.totalCents : 0;
    const depositPart = depositShare === null ? NEUTRAL : clamp(1 - depositShare * 2); // 0% → 1, 50%+ → 0
    const deliveryPart = q.deliveryIncluded === true ? 1 : q.deliveryIncluded === false ? 0.3 : NEUTRAL;
    factors.push({ name: "terms", score: round((depositPart + deliveryPart) / 2), weight: w.terms, neutral: depositShare === null && q.deliveryIncluded === null, note: `${depositShare === null ? "deposit not stated" : `${Math.round(depositShare * 100)}% deposit`}, ${q.deliveryIncluded === true ? "delivery included" : q.deliveryIncluded === false ? "delivery extra" : "delivery not stated"}` });

    const score = factors.reduce((a, f) => a + f.score * f.weight, 0);
    const evidenceWeight = factors.filter((f) => !f.neutral).reduce((a, f) => a + f.weight, 0);
    return { quoteId: q.quoteId, businessId: q.businessId, business: q.business, totalCents: q.totalCents, score: round(score), confidence: round(clamp(evidenceWeight) * clamp(q.confidence)), factors };
  });

  const conf = new Map(quotes.map((q) => [q.quoteId, q.confidence]));
  const tier = new Map(quotes.map((q) => [q.quoteId, q.tier ?? 0]));
  ranked.sort((a, b) => (tier.get(a.quoteId)! - tier.get(b.quoteId)!) || (Math.abs(b.score - a.score) > TIE ? b.score - a.score : a.totalCents - b.totalCents || (conf.get(b.quoteId)! - conf.get(a.quoteId)!) || a.quoteId.localeCompare(b.quoteId)));
  const win = ranked[0]!;
  return { method: "best_value", weights: w, ranked, recommendedQuoteId: win.quoteId, explanation: explain(win, ranked.slice(1), quotes) };
}

function strongest(s: ValueScore, than: ValueScore): Factor[] {
  return s.factors.filter((f) => f.weight > 0).map((f) => ({ f, d: (f.score - (than.factors.find((x) => x.name === f.name)?.score ?? f.score)) * f.weight })).filter((x) => x.d > 0.004).sort((a, b) => b.d - a.d).map((x) => x.f);
}

function explain(win: ValueScore, others: ValueScore[], inputs: ValueInput[]): ValueRanking["explanation"] {
  const input = new Map(inputs.map((q) => [q.quoteId, q]));
  const neg = (s: ValueScore) => { const i = input.get(s.quoteId); return i?.negotiatedFromCents && i.negotiatedFromCents > s.totalCents ? ` (negotiated down from ${usd(i.negotiatedFromCents)})` : ""; };
  const cheapestOverall = Math.min(win.totalCents, ...others.map((o) => o.totalCents));
  const lead = win.totalCents === cheapestOverall
    ? `lowest all-in total ${usd(win.totalCents)}${neg(win)}`
    : `${usd(win.totalCents)}${neg(win)}, ${usd(win.totalCents - cheapestOverall)} more than the cheapest eligible quote, but ${strongest(win, others.find((o) => o.totalCents === cheapestOverall) ?? others[0]!).slice(0, 2).map((f) => f.note).join("; ") || "better overall terms"}`;
  return {
    winner: `${win.business}: best value ${win.score.toFixed(2)} — ${lead}.`,
    others: others.map((o) => {
      // Pairwise: the price reason compares these two quotes (the winner's own note is relative to the cheapest overall).
      const better = strongest(win, o).slice(0, 2).map((f) => f.name === "price" ? `price: ${usd(o.totalCents - win.totalCents)} cheaper than ${o.business}` : `${f.name}: ${win.factors.find((x) => x.name === f.name)!.note}`);
      const own = o.totalCents < win.totalCents ? `${usd(win.totalCents - o.totalCents)} cheaper (${usd(o.totalCents)}${neg(o)}), ` : `${usd(o.totalCents)}${neg(o)}, `;
      return { quote_id: o.quoteId, text: `${o.business}: ${own}value ${o.score.toFixed(2)} vs ${win.score.toFixed(2)}${better.length ? `; ${win.business} is ahead on ${better.join("; ")}` : ""}.` };
    }),
  };
}
