// PURE: deterministic quote.json (contract QuotePart, "quote/1") -> extraction. No LLM: a
// structured quote is read exactly, every figure sourced to "quote.json".
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

export function quotePartToExtraction(raw: unknown, jobId: string, reqs: EngineRequirement[], headcount: number): QuotePartParse {
  const r = QuotePartSchema.safeParse(raw);
  if (!r.success) return { ok: false, reason: "quote.json does not match quote/1" };
  const p = r.data;
  if (p.job_id !== jobId) return { ok: false, reason: "quote.json is for another job" };
  const met = new Map((p.requirements_met ?? []).map((m) => [m.requirement_id, m.met]));
  const src = (field: QuoteExtraction["sources"][number]["field"], v: number | undefined) => (v === undefined ? [] : [{ field, source: "quote.json", excerpt: `${field}=${v}` }]);
  const dietary = reqs
    .filter((q) => q.kind === "dietary" && q.need)
    .map((q) => (met.has(q.id) ? { need: q.need!, covered: met.get(q.id)!, count_offered: met.get(q.id) ? (q.min_count ?? null) : 0 } : null))
    .filter((d): d is NonNullable<typeof d> => d !== null);
  const deliveryReq = reqs.find((q) => q.kind === "delivery");
  const deliveryMet = deliveryReq ? met.get(deliveryReq.id) : undefined;
  return {
    ok: true,
    extraction: {
      available: true,
      price_per_head_usd: p.per_unit_usd ?? null,
      headcount,
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
