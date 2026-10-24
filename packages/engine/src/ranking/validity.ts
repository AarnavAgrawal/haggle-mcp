// PURE: is a quote still fresh enough to approve? A quote is good until the earlier of the date the
// business stated (valid_until, through the end of that day, UTC: the conservative side for US
// timezones) and a default validity window from when it was given or last re-confirmed. A stale quote
// is never approved as is: Haggle first asks the business to re-confirm it (engine re-confirmation).

/** Default validity when the business stated none: 7 days from the quote (or its re-confirmation). */
export const DEFAULT_QUOTE_VALIDITY_MS = 7 * 24 * 60 * 60_000;

export interface QuoteFreshness {
  stale: boolean;
  /** "expired": past the business's own valid_until; "aged": older than the validity window. */
  reason: "expired" | "aged" | null;
  /** When the quote stops being approvable as is (ISO). */
  good_until: string;
  /** The business's stated date, if any (YYYY-MM-DD). */
  valid_until: string | null;
}

/** End of the stated day in UTC, or null when it isn't a YYYY-MM-DD date. */
export function validUntilEnd(validUntil: string | null | undefined): number | null {
  if (!validUntil || !/^\d{4}-\d{2}-\d{2}/.test(validUntil)) return null;
  const t = Date.parse(`${validUntil.slice(0, 10)}T23:59:59.999Z`);
  return Number.isNaN(t) ? null : t;
}

/**
 * `reconfirmedAt`: when the business last confirmed this exact quote still stands (a fresh window
 * starts then, and it outlives a stated valid_until that has passed since, because the business said
 * so after that date).
 */
export function quoteFreshness(q: { created_at: string; valid_until: string | null }, now: Date, windowMs = DEFAULT_QUOTE_VALIDITY_MS, reconfirmedAt?: string | null): QuoteFreshness {
  const base = Math.max(Date.parse(q.created_at), reconfirmedAt ? Date.parse(reconfirmedAt) : -Infinity);
  const stated = validUntilEnd(q.valid_until);
  const statedStillCounts = stated !== null && !(reconfirmedAt && Date.parse(reconfirmedAt) > stated);
  const windowEnd = base + windowMs;
  const goodUntil = statedStillCounts ? Math.min(stated!, windowEnd) : windowEnd;
  const t = now.getTime();
  const reason = t <= goodUntil ? null : statedStillCounts && stated! < windowEnd ? "expired" : "aged";
  return { stale: reason !== null, reason, good_until: new Date(goodUntil).toISOString(), valid_until: q.valid_until };
}
