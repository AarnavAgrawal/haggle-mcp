// PURE: which quote is "best" (DESIGN.md §8.3).
import type { JobRow, QuoteRow } from "../db/queries.js";

/** Every requested dietary need is explicitly covered. */
export function dietaryOk(job: Pick<JobRow, "event">, q: Pick<QuoteRow, "dietary_coverage">): boolean {
  return job.event.dietary.every((d) => q.dietary_coverage[d.need.trim().toLowerCase()] === true);
}

/**
 * The lowest total among available quotes that cover every dietary need and
 * have no missing price fields.
 */
export function pickBest(job: Pick<JobRow, "event">, quotes: QuoteRow[]): QuoteRow | null {
  const eligible = quotes.filter(
    (q) => q.available && q.total_cents !== null && q.price_per_head_cents !== null && dietaryOk(job, q),
  );
  eligible.sort((a, b) => a.total_cents! - b.total_cents!);
  return eligible[0] ?? null;
}
