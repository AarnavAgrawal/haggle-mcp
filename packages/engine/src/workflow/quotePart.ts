// PURE: deterministic quote.json -> extraction. No LLM: a structured quote is read exactly, every
// figure sourced to "quote.json". Three shapes are in circulation and all are accepted:
//   - v3 engine QuotePart: { haggle: "quote/1", job_id, business, total_usd, items: string[], requirements_met[] }
//   - CONTRACTS.md §5:     { protocol: "haggle.v0", type: "quote", job_id, total_usd, items[{description,quantity,tags}], meets{} }
//   - Aarnav's sellers:    { protocol: "haggle.quote.v1", type: "quote", total_usd, vegetarian_meals, delivery_included, ... }
// v5 shapes are normalised to the v3 one. Seller claims (`meets`) are re-checked against the stated
// vegetarian count / item tags; a stated count always wins over a claim.
import { z } from "zod";
import type { QuoteExtraction } from "../parsing/extraction.ts";
import type { EngineRequirement } from "../parsing/requirements.ts";

const usd = z.number().finite().nonnegative();
export const QuotePartSchema = z.object({
  haggle: z.literal("quote/1"),
  job_id: z.string().min(1),
  business: z.string().min(1).max(200),
  total_usd: usd,
  per_unit_usd: usd.optional(),
  deposit_usd: usd.optional(),
  delivery_usd: usd.optional(),
  tax_usd: usd.optional(),
  items: z.array(z.string().max(200)).max(50),
  requirements_met: z.array(z.object({ requirement_id: z.string(), met: z.boolean() })).optional(),
  valid_until: z.string(),
  revision_of: usd.optional(),
});

export type QuotePartParse = { ok: true; extraction: QuoteExtraction } | { ok: false; reason: string };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const V5Item = z.union([z.string().max(200), z.object({ description: z.string().max(200), quantity: z.number().optional(), tags: z.array(z.string()).optional() }).passthrough()]);
const V5Quote = z.object({
  protocol: z.enum(["haggle.v0", "haggle.quote.v1"]),
  type: z.literal("quote"),
  job_id: z.string().min(1).optional(),
  business: z.string().max(200).optional(),
  seller: z.string().max(200).optional(),
  total_usd: usd,
  items: z.array(V5Item).max(50).optional(),
  meets: z.record(z.string(), z.boolean()).optional(),
  valid_until: z.string().optional(),
}).passthrough();

/**
 * v5 quote.json (contract or seller shape) -> v3 QuotePart + the stated vegetarian count. Returns
 * null when it isn't a v5 quote. `job_id` may be absent (the message is already matched to the job).
 */
function fromV5(raw: unknown, jobId: string, reqs: EngineRequirement[]): { part: z.infer<typeof QuotePartSchema>; vegetarian?: number; deliveryIncluded?: boolean } | { error: string } | null {
  const r = V5Quote.safeParse(raw);
  if (!r.success) return raw && typeof raw === "object" && (raw as { type?: unknown }).type === "quote" ? { error: "quote.json (v5) is malformed" } : null;
  const q = r.data as z.infer<typeof V5Quote> & Record<string, unknown>;
  const items = (q.items ?? []).map((i) => (typeof i === "string" ? i : `${i.quantity ? `${i.quantity} ` : ""}${i.description}`));
  const tagged = (q.items ?? []).filter((i): i is { description: string; quantity?: number; tags?: string[] } => typeof i !== "string" && (i.tags ?? []).some((t) => /^veg(etarian)?$/i.test(t)));
  const vegetarian = num(q.vegetarian_meals) ?? (tagged.length ? tagged.reduce((n, i) => n + (i.quantity ?? 0), 0) : undefined);
  const deliveryIncluded = typeof q.delivery_included === "boolean" ? q.delivery_included : undefined;
  const requirements_met = Object.entries(q.meets ?? {}).map(([requirement_id, met]) => ({ requirement_id, met }));
  // Re-check claims: the stated vegetarian count overrides a `meets` claim for dietary requirements.
  for (const req of reqs.filter((x) => x.kind === "dietary" && x.need && /vegetarian/i.test(x.need) && x.min_count !== undefined)) {
    if (vegetarian === undefined) continue;
    const i = requirements_met.findIndex((m) => m.requirement_id === req.id);
    const verdict = { requirement_id: req.id, met: vegetarian >= req.min_count! };
    if (i >= 0) requirements_met[i] = verdict; else requirements_met.push(verdict);
  }
  for (const req of reqs.filter((x) => x.kind === "delivery")) {
    if (deliveryIncluded !== undefined && !requirements_met.some((m) => m.requirement_id === req.id)) requirements_met.push({ requirement_id: req.id, met: deliveryIncluded });
  }
  const per = num(q.per_unit_usd) ?? num(q.per_head_usd);
  const part = {
    haggle: "quote/1" as const, job_id: q.job_id ?? jobId, business: q.business ?? q.seller ?? "", total_usd: q.total_usd,
    ...(per !== undefined ? { per_unit_usd: per } : {}), ...(num(q.deposit_usd) !== undefined ? { deposit_usd: num(q.deposit_usd)! } : {}),
    ...(num(q.delivery_usd) !== undefined ? { delivery_usd: num(q.delivery_usd)! } : {}), ...(num(q.tax_usd) !== undefined ? { tax_usd: num(q.tax_usd)! } : {}),
    items, requirements_met, valid_until: q.valid_until ?? "", ...(num(q.negotiated_from) !== undefined ? { revision_of: num(q.negotiated_from)! } : {}),
  };
  return { part, ...(vegetarian !== undefined ? { vegetarian } : {}), ...(deliveryIncluded !== undefined ? { deliveryIncluded } : {}) };
}

export function quotePartToExtraction(raw: unknown, jobId: string, reqs: EngineRequirement[], headcount: number | undefined): QuotePartParse {
  const v5 = fromV5(raw, jobId, reqs);
  if (v5 && "error" in v5) return { ok: false, reason: v5.error };
  const r = v5 ? { success: true as const, data: v5.part } : QuotePartSchema.safeParse(raw);
  if (!r.success) return { ok: false, reason: "quote.json does not match quote/1" };
  const p = r.data;
  const statedVeg = v5 && "part" in v5 ? v5.vegetarian : undefined;
  if (p.job_id !== jobId) return { ok: false, reason: "quote.json is for another job" };
  const met = new Map((p.requirements_met ?? []).map((m) => [m.requirement_id, m.met]));
  const src = (field: QuoteExtraction["sources"][number]["field"], v: number | undefined) => (v === undefined ? [] : [{ field, source: "quote.json", excerpt: `${field}=${v}` }]);
  const dietary = reqs
    .filter((q) => q.kind === "dietary" && q.need)
    .map((q) => (statedVeg !== undefined && /vegetarian/i.test(q.need!) ? { need: q.need!, covered: statedVeg >= (q.min_count ?? 0), count_offered: statedVeg }
      : met.has(q.id) ? { need: q.need!, covered: met.get(q.id)!, count_offered: met.get(q.id) ? (q.min_count ?? null) : 0 } : null))
    .filter((d): d is NonNullable<typeof d> => d !== null);
  const deliveryReq = reqs.find((q) => q.kind === "delivery");
  const deliveryMet = deliveryReq ? met.get(deliveryReq.id) : undefined;
  return {
    ok: true,
    extraction: {
      available: true,
      price_per_head_usd: p.per_unit_usd ?? null,
      headcount: headcount ?? null,
      // quote.json carries no quantity of its own: this is the request's, never a figure to multiply.
      headcount_assumed: true,
      subtotal_usd: null,
      delivery_fee_usd: p.delivery_usd ?? null,
      delivery_included: deliveryMet ?? (p.delivery_usd !== undefined ? true : null),
      tax_usd: p.tax_usd ?? null,
      tax_included: p.tax_usd !== undefined ? true : null,
      total_usd: p.total_usd,
      deposit_usd: p.deposit_usd ?? null,
      menu_items: p.items,
      dietary_coverage: dietary,
      valid_until: /^\d{4}-\d{2}-\d{2}/.test(p.valid_until) ? p.valid_until.slice(0, 10) : null,
      questions: [],
      payment_request: "none",
      instructions_to_agent: false,
      sources: [...src("total", p.total_usd), ...src("deposit", p.deposit_usd), ...src("delivery_fee", p.delivery_usd), ...src("tax", p.tax_usd), ...src("price_per_head", p.per_unit_usd)],
      missing_fields: [],
      confidence: 1,
    },
  };
}
