// What the parser extracts from a vendor reply (DESIGN.md §11.1).
// Dollars here; validate.ts converts to integer cents before saving.
//
// Kept to plain types (no record keys, no numeric bounds) so it works as a
// Claude structured-output schema. validate.ts enforces the bounds instead:
// menu capped at 20 items, confidence clamped to [0, 1].
import { z } from "zod";

export const QuoteExtraction = z.object({
  available: z.boolean().describe("False if the vendor declined or can't do the date"),
  price_per_head_usd: z.number().nullable(),
  headcount: z.number().int().nullable(),
  subtotal_usd: z.number().nullable(),
  delivery_fee_usd: z.number().nullable(),
  tax_usd: z.number().nullable(),
  total_usd: z.number().nullable(),
  deposit_usd: z.number().nullable(),
  menu_items: z.array(z.string()).describe("Up to 20 menu items the vendor named"),
  dietary_coverage: z
    .array(z.object({ need: z.string(), covered: z.boolean() }))
    .describe("For each requested dietary need, whether the vendor said they can cover it"),
  valid_until: z.string().nullable().describe("YYYY-MM-DD if stated"),
  missing_fields: z
    .array(z.string())
    .describe("Fields the vendor did not state. Never guess a number to fill a field."),
  confidence: z.number().describe("0 to 1: how sure you are the extraction is right"),
});

export type QuoteExtraction = z.infer<typeof QuoteExtraction>;

/** The cents-based record that gets saved to the quotes table. */
export interface QuoteRecord {
  available: boolean;
  price_per_head_cents: number | null;
  headcount: number | null;
  subtotal_cents: number | null;
  delivery_fee_cents: number | null;
  tax_cents: number | null;
  total_cents: number | null;
  deposit_cents: number | null;
  menu_items: string[];
  dietary_coverage: Record<string, boolean>;
  valid_until: string | null;
  missing_fields: string[];
  confidence: number;
}
