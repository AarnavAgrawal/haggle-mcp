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
  /** False when the all-in total isn't confirmed (delivery not stated, or tax excluded with no amount). */
  allInKnown?: boolean;
}

export type RejectReason = "not_current" | "unavailable" | "unverified_sender" | "external_payment_link" | "prompt_injection" | "requirement_unmet" | "no_total" | "all_in_unknown" | "over_budget";

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
  if (q.totalCents === null) return "no_total";
  if (q.allInKnown === false) return "all_in_unknown";
  if (budgetCents !== null && q.totalCents > budgetCents) return "over_budget";
  return null;
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
  ranked.sort((a, b) => a.totalCents! - b.totalCents! || b.confidence - a.confidence || a.quoteId.localeCompare(b.quoteId));
  return { ranked, recommendedQuoteId: ranked[0]?.quoteId ?? null, rejected };
}
