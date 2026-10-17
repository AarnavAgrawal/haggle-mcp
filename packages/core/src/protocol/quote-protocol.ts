import { z } from "zod";

/**
 * Haggle Quote Protocol v0 — the JSON parts that ride alongside readable email.
 *
 * STATUS: PROPOSED by the buyer side. The seller side (Partner) owns the
 * protocol section of CONTRACTS.md; nothing here is frozen until both sides
 * confirm it there. Wire amounts are decimal USD (as in the original plan's
 * quote schema); Haggle converts to integer cents on ingestion.
 *
 * Parsing is deliberately tolerant of unknown keys (forward compatible) and
 * strict about types of known keys. A part that fails validation is never
 * "half trusted": the quote falls back to text extraction and is flagged.
 */
export const PROTOCOL_VERSION = "haggle.v0";

const UsdAmount = z.number().finite().nonnegative().max(10_000_000);
const IsoDateTime = z.iso.datetime({ offset: true });

export const RfqPart = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  type: z.literal("rfq"),
  job_id: z.string(),
  what: z.string().max(2000),
  quantity: z
    .object({ amount: z.number().int().positive(), unit: z.string().max(60) })
    .optional(),
  date: z.string().max(40).optional(),
  location: z.string().max(200).optional(),
  /** Human-readable requirement labels plus a stable id the seller can reference. */
  requirements: z.array(z.object({ id: z.string(), label: z.string(), mandatory: z.boolean() })).max(30),
  /** Optional hint; Haggle never reveals the real ceiling. */
  budget_hint_usd: UsdAmount.optional(),
  reply_by: IsoDateTime,
  reply_instructions: z.string().max(500).optional(),
});
export type RfqPart = z.infer<typeof RfqPart>;

export const QuotePartItem = z.looseObject({
  description: z.string().max(300),
  quantity: z.number().int().nonnegative().optional(),
  unit_price_usd: UsdAmount.optional(),
  total_usd: UsdAmount.optional(),
  tags: z.array(z.string().max(40)).max(10).optional(),
});

export const QuotePart = z.looseObject({
  protocol: z.literal(PROTOCOL_VERSION),
  type: z.literal("quote"),
  job_id: z.string(),
  seller: z.string().max(120).optional(),
  seller_kind: z.enum(["agent", "human"]).optional(),
  items: z.array(QuotePartItem).max(100).optional(),
  subtotal_usd: UsdAmount.optional(),
  delivery_usd: UsdAmount.optional(),
  delivery_included: z.boolean().optional(),
  tax_usd: UsdAmount.optional(),
  tax_included: z.boolean().optional(),
  fees: z.array(z.object({ label: z.string().max(120), amount_usd: UsdAmount })).max(20).optional(),
  total_usd: UsdAmount,
  per_head_usd: UsdAmount.optional(),
  deposit_usd: UsdAmount.optional(),
  payment_terms: z.string().max(500).optional(),
  fulfillment_date: z.string().max(40).optional(),
  /** Seller's own claim per requirement id; Haggle re-checks against items. */
  meets: z.record(z.string(), z.boolean()).optional(),
  valid_until: IsoDateTime.optional(),
  /** Which counter round this quote answers, if any. */
  round: z.number().int().nonnegative().optional(),
  revision: z.number().int().positive().optional(),
});
export type QuotePart = z.infer<typeof QuotePart>;

export const CounterPart = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  type: z.literal("counter"),
  job_id: z.string(),
  round: z.number().int().positive(),
  target_total_usd: UsdAmount,
  /** Honest basis, e.g. "competing compliant quote q_3 at $1,050.00". */
  basis: z.string().max(300),
  respond_by: IsoDateTime,
});
export type CounterPart = z.infer<typeof CounterPart>;

export const PROTOCOL_PART_FILENAMES = {
  rfq: "rfq.json",
  quote: "quote.json",
  counter: "counter.json",
} as const;

/** Safely parse a JSON protocol part. Returns a typed error instead of throwing. */
export function parseProtocolPart<T extends z.ZodType>(
  schema: T,
  raw: string,
): { ok: true; value: z.infer<T> } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    return { ok: false, error: z.prettifyError(result.error).slice(0, 1000) };
  }
  return { ok: true, value: result.data };
}
