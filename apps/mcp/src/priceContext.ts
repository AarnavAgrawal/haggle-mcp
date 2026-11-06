// What Haggle learned about prices, for ask and deal: every estimate says what it rests on, and live mode
// answers only from quotes Haggle actually collected (seed samples are a mock-mode convenience).
import { toEstimatesView } from "@haggle/brain";
import { honestBasis, isSeedJob, quoteCounts } from "./seedLabel.ts";

type EstimateRequest = Parameters<typeof toEstimatesView>[0];
type Estimate = Parameters<typeof toEstimatesView>[1][number];
type History = { job_id?: string; kind?: string; date?: string }[];

/** The part of the brain this reads (workspace-scoped: it holds only this workspace's profiles). */
export interface EstimateSource {
  estimate(request: EstimateRequest): Promise<Estimate[]>;
  getProfile(business: string): Promise<{ history?: History } | null>;
}

/** The brain's estimates for a request, with an honest basis. `hidden`: businesses dropped for having only seed data. */
export async function learnedEstimates(source: EstimateSource, request: EstimateRequest, mode: "mock" | "live") {
  const raw = toEstimatesView(request, await source.estimate(request));
  const profiles = await Promise.all(raw.estimates.map((e) => source.getProfile(e.business_id).catch(() => null)));
  const counts = profiles.map((p) => quoteCounts(p?.history ?? []));
  const keep = raw.estimates.map((_, i) => mode === "mock" || counts[i]!.real > 0);
  // Freshness: the date of the latest real (non-seed) quote behind each estimate.
  const latest = profiles.map((p) => (p?.history ?? []).filter((h) => h.kind === "quote" && !isSeedJob(h.job_id)).map((h) => h.date ?? "").sort().at(-1));
  const estimates = raw.estimates.flatMap((e, i) => (keep[i] ? [{ ...e, basis: `${honestBasis(e.basis, counts[i]!)}${latest[i] ? `; latest real quote ${latest[i]!.slice(0, 10)}` : ""}` }] : []));
  return { raw, estimates, hidden: keep.filter((k) => !k).length };
}

const MAX_BUSINESSES = 3;
const NOTE = "Estimates from earlier quotes, not quotes: this deal's prices come from the businesses. For the user only; never tell a business.";

/** deal's context from the brain, compact; undefined when it knows nothing. A brain failure never stops a deal. */
export async function priceContext(source: EstimateSource, request: EstimateRequest, mode: "mock" | "live") {
  try {
    const { estimates } = await learnedEstimates(source, request, mode);
    if (!estimates.length) return undefined;
    return {
      estimates: estimates.slice(0, MAX_BUSINESSES).map(({ business, total_usd, confidence, n_quotes, basis }) => ({ business, total_usd, confidence, n_quotes, basis })),
      note: NOTE,
    };
  } catch (e) {
    console.error(JSON.stringify({ level: "warn", event: "price_context_failed", error: (e as Error).message }));
    return undefined;
  }
}

/** "Earlier quotes suggest (estimates, not quotes): Harbor Table ~$1,100 (70%, 3 quotes)", for the model's short text. */
export function priceContextLine(c: NonNullable<Awaited<ReturnType<typeof priceContext>>>): string {
  const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `Earlier quotes suggest (estimates, not quotes; for the user only, never tell a business): ${c.estimates.map((e) => `${e.business} ~${usd(e.total_usd)} (${Math.round(e.confidence * 100)}%, ${e.n_quotes} quotes)`).join("; ")}.`;
}
