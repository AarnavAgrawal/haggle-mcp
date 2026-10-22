// PURE: rank recorded quotes. Only what is unsafe or unusable is excluded (superseded, declined,
// unverified sender, payment-link scam, prompt injection, no price). The human's preferences
// (hard requirements, a target budget, required answers) are soft: a quote that misses one still
// ranks, after the quotes that don't, and carries the miss as a caveat. The human decides. That
// includes a budget the buyer set as an absolute limit (budget_kind "limit"): a quote above it ranks
// lower with an "over your limit" caveat, and can still be countered and knowingly approved. Only a
// quote that misses nothing may win on its own (be recommended or texted for a YES): see
// compliance.ts. An unconfirmed requirement ranks below a confirmed one (never as if met).
//
// Adapted from quote-broker@8a68559 src/tools/best.ts `pickBest` (Partner): lowest total among
// complete, available, requirement-covering quotes, unknown coverage = not covered. Changes for
// Haggle v3: sender trust, budget, current-revision and untrusted-content flags, a full ordering
// with rejection reasons instead of a single pick.

export interface RankableQuote {
  quoteId: string;
  businessId: string;
  totalCents: number | null;
  available: boolean;
  compliant: boolean;
  senderTrusted: boolean;
  status: "current" | "superseded" | "expired" | "withdrawn";
  confidence: number;
  flags: string[];
  /** False when the all-in total isn't confirmed (delivery not stated, or tax excluded with no amount). */
  allInKnown?: boolean;
  // Custom requests (ask + compare_by), all optional; absent = rank by total, lowest first.
  /** The compare_by value when it isn't money (number, or a YYYY-MM-DD / HH:MM string). */
  sortValue?: number | string | null;
  direction?: "min" | "max";
  /** False when the request compares a non-money field: a quote can win without a total. */
  needsTotal?: boolean;
  /** A required ask answer is missing (a follow-up asks for it). */
  missingRequired?: boolean;
  /** A hard requirement the business said it does NOT meet (vs. merely not confirmed). Default: !compliant. */
  unmet?: boolean;
  /** What approval would pay now (deposit, else the full total) is over the spending cap: it can't be approved as is. */
  overCap?: boolean;
}

export type RejectReason = "not_current" | "unavailable" | "unverified_sender" | "external_payment_link" | "prompt_injection" | "requirement_unmet" | "missing_info" | "no_total" | "all_in_unknown" | "over_budget";

/** A preference a ranked quote misses: shown with it, never a reason to hide it. */
export type SoftReason = "requirement_unmet" | "requirement_unknown" | "missing_info" | "over_budget" | "over_limit" | "over_cap";

export interface Ranking {
  ranked: RankableQuote[]; // best first: every safe, priced quote
  recommendedQuoteId: string | null;
  /** Unsafe or unusable quotes, with the reason (never ranked, approved or cited). */
  rejected: { quoteId: string; businessId: string; reason: RejectReason }[];
  /** Ranked quotes that miss a preference, and which. */
  caveats: { quoteId: string; businessId: string; reasons: SoftReason[] }[];
}

/** A hard requirement the business said it doesn't meet (unknown = not confirmed, which is milder). */
export const missesRequirement = (q: Pick<RankableQuote, "compliant" | "unmet">) => q.unmet ?? !q.compliant;

/**
 * Why a quote can't rank (or be cited in negotiation): only safety or no comparable price; null = an
 * option. Budgets (a target or a "limit") are soft reasons (softReasons), never a rejection; the
 * second parameter is kept for callers that still pass a limit, and is ignored.
 */
export function rejectReason(q: RankableQuote, _limitCents: number | null = null): RejectReason | null {
  if (q.status !== "current") return "not_current";
  if (!q.available) return "unavailable";
  if (!q.senderTrusted) return "unverified_sender";
  if (q.flags.includes("external_payment_link")) return "external_payment_link";
  if (q.flags.includes("prompt_injection")) return "prompt_injection";
  // Requirements and budget are soft (softReasons below). An unknown all-in total still ranks; it only
  // blocks approval (engine approvability), like an approximate total.
  if (q.needsTotal === false) {
    if (q.sortValue === null || q.sortValue === undefined) return "missing_info";
  } else if (q.totalCents === null || q.totalCents <= 0) return "no_total"; // a $0 total is never a price to rank, cite or pay
  return null;
}

/** The preferences an option misses (empty = meets everything that was asked). */
export function softReasons(q: RankableQuote, budgetCents: number | null, limitCents: number | null = null): SoftReason[] {
  const out: SoftReason[] = [];
  if (!q.compliant) out.push(missesRequirement(q) ? "requirement_unmet" : "requirement_unknown");
  if (q.missingRequired) out.push("missing_info");
  if (budgetCents !== null && q.totalCents !== null && q.totalCents > budgetCents) out.push("over_budget");
  if (limitCents !== null && q.totalCents !== null && q.totalCents > limitCents) out.push("over_limit");
  return out;
}

/**
 * How much a quote misses (lower ranks first), the same weights as the value ranking's tier: a stated
 * miss, an over-limit total or a pay-now amount over the cap is worst, an unconfirmed requirement next
 * (never ranked as if met), then a missing required answer or being over a target budget.
 */
export function softTierOf(reasons: readonly string[]): number {
  const w: Record<string, number> = { requirement_unmet: 4, over_limit: 4, over_cap: 4, requirement_unknown: 2, missing_info: 1, over_budget: 1 };
  return reasons.reduce((n, r) => n + (w[r] ?? 0), 0);
}

/** A pay-now amount over the cap isn't a preference the business missed (no caveat), but it can't be approved as is: it ranks with the stated misses. */
function tier(q: RankableQuote, budgetCents: number | null, limitCents: number | null): number {
  return softTierOf([...softReasons(q, budgetCents, limitCents), ...(q.overCap ? ["over_cap"] : [])]);
}

/** Ascending order of the comparable value (total cents, or the custom compare value). */
function compareKey(a: RankableQuote, b: RankableQuote): number {
  const va = a.needsTotal === false ? a.sortValue : a.totalCents;
  const vb = b.needsTotal === false ? b.sortValue : b.totalCents;
  if (typeof va === "number" && typeof vb === "number") return va - vb;
  return String(va).localeCompare(String(vb));
}

/**
 * `budgetCents`: the buyer's budget, a target or a "limit": over it is a soft caveat either way.
 * `limitCents`: the budget when it is an absolute limit; over it ranks with the stated misses (still
 * never a rejection). `recommendedQuoteId` is the best quote that misses nothing, else null: a quote
 * with a caveat never wins by default.
 */
export function rankQuotes(quotes: RankableQuote[], budgetCents: number | null, limitCents: number | null = null): Ranking {
  const ranked: RankableQuote[] = [];
  const rejected: Ranking["rejected"] = [];
  for (const q of quotes) {
    const reason = rejectReason(q);
    if (reason) {
      if (reason !== "not_current") rejected.push({ quoteId: q.quoteId, businessId: q.businessId, reason });
    } else ranked.push(q);
  }
  ranked.sort((a, b) => tier(a, budgetCents, limitCents) - tier(b, budgetCents, limitCents) || (a.direction === "max" ? -compareKey(a, b) : compareKey(a, b)) || b.confidence - a.confidence || a.quoteId.localeCompare(b.quoteId));
  const caveats = ranked.map((q) => ({ quoteId: q.quoteId, businessId: q.businessId, reasons: softReasons(q, budgetCents, limitCents) })).filter((c) => c.reasons.length > 0);
  const withCaveat = new Set([...caveats.map((c) => c.quoteId), ...ranked.filter((q) => q.overCap).map((q) => q.quoteId)]);
  return { ranked, recommendedQuoteId: ranked.find((q) => !withCaveat.has(q.quoteId))?.quoteId ?? null, rejected, caveats };
}
