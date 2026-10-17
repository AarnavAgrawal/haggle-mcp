// The brain is seeded from fixtures/brain/seed-replies.json (job ids "job_seed_*") so warm asks work
// before any live deal. Those are sample quotes, not quotes Haggle collected: say so wherever the
// brain's wording says "real quote".
type History = { job_id?: string; kind?: string }[];

export const isSeedJob = (jobId: string | undefined) => typeof jobId === "string" && jobId.startsWith("job_seed");

export function quoteCounts(history: History): { real: number; seed: number } {
  const quotes = history.filter((h) => h.kind === "quote");
  const seed = quotes.filter((h) => isSeedJob(h.job_id)).length;
  return { real: quotes.length - seed, seed };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** "based on 3 real quotes" → "based on 3 sample quotes (seed data, not live)" or "1 real quote + 2 seed samples". */
export function honestBasis(text: string, c: { real: number; seed: number }): string {
  if (c.seed === 0) return text;
  const said = c.real === 0 ? `${plural(c.seed, "sample quote")} (seed data, not live)` : `${plural(c.real, "real quote")} + ${plural(c.seed, "seed sample")}`;
  return text.replace(/\b\d+ real quotes?\b/i, said);
}

/** The profile view's history rows (newest first, at most 10) that came from seed data. */
export function seedRows(history: History): boolean[] {
  return [...history].reverse().slice(0, 10).map((h) => isSeedJob(h.job_id));
}
