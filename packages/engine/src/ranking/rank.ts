// PURE: rank recorded quotes. Only genuine, current, compliant, trusted, priced quotes within
// budget can rank; everything else is listed with the reason it can't win.
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
  // Custom requests (ask + compare_by), all optional; absent = rank by total, lowest first.
  /** The compare_by value when it isn't money (number, or a YYYY-MM-DD / HH:MM string). */
  sortValue?: number | string | null;
  direction?: "min" | "max";
  /** False when the request compares a non-money field: a quote can win without a total. */
  needsTotal?: boolean;
  /** A required ask answer is missing (a follow-up asks for it). */
  missingRequired?: boolean;
}

export type RejectReason = "not_current" | "unavailable" | "unverified_sender" | "external_payment_link" | "prompt_injection" | "requirement_unmet" | "missing_info" | "no_total" | "over_budget";

export interface Ranking {
  ranked: RankableQuote[]; // best first
  recommendedQuoteId: string | null;
  rejected: { quoteId: string; businessId: string; reason: RejectReason }[];
}

/** Why a quote can't rank (or be cited in negotiation); null = eligible. Shared by ranking and negotiation. */
export function rejectReason(q: RankableQuote, budgetCents: number | null): RejectReason | null {
  if (q.status !== "current") return "not_current";
  if (!q.available) return "unavailable";
  if (!q.senderTrusted) return "unverified_sender";
  if (q.flags.includes("external_payment_link")) return "external_payment_link";
  if (q.flags.includes("prompt_injection")) return "prompt_injection";
  if (!q.compliant) return "requirement_unmet";
  if (q.missingRequired) return "missing_info";
  if (q.needsTotal === false) {
    if (q.sortValue === null || q.sortValue === undefined) return "missing_info";
  } else if (q.totalCents === null) return "no_total";
  if (budgetCents !== null && q.totalCents !== null && q.totalCents > budgetCents) return "over_budget";
  return null;
}

/** Ascending order of the comparable value (total cents, or the custom compare value). */
function compareKey(a: RankableQuote, b: RankableQuote): number {
  const va = a.needsTotal === false ? a.sortValue : a.totalCents;
  const vb = b.needsTotal === false ? b.sortValue : b.totalCents;
  if (typeof va === "number" && typeof vb === "number") return va - vb;
  return String(va).localeCompare(String(vb));
}

export function rankQuotes(quotes: RankableQuote[], budgetCents: number | null): Ranking {
  const ranked: RankableQuote[] = [];
  const rejected: Ranking["rejected"] = [];
  for (const q of quotes) {
    const reason = rejectReason(q, budgetCents);
    if (reason) {
      if (reason !== "not_current") rejected.push({ quoteId: q.quoteId, businessId: q.businessId, reason });
    } else ranked.push(q);
  }
  ranked.sort((a, b) => (a.direction === "max" ? -compareKey(a, b) : compareKey(a, b)) || b.confidence - a.confidence || a.quoteId.localeCompare(b.quoteId));
  return { ranked, recommendedQuoteId: ranked[0]?.quoteId ?? null, rejected };
}
