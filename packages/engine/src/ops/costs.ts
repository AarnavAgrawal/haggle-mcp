// Approximate Anthropic cost from recorded usage (sprint 5, E). APPROXIMATE by construction: it
// multiplies the token counts each response reported (ai_usage_events, migration 122) by a list
// price. It is not an invoice: it ignores discounts, batch pricing, partner-platform pricing (Bedrock,
// Vertex), taxes, and anything the API didn't report in `usage`.
//
// PRICING ASSUMPTIONS (USD per million tokens, Anthropic first-party API). Source: the Claude API
// model table as cached 2026-10-06 (claude-api skill, "Current Models"); checked 2026-10-22.
//   - input / output: the listed prices.
//   - cache_read: listed where the table states it (Opus 5.5, Sonnet 5.5: $0.20; Fable 5.1: $0.25);
//     otherwise ASSUMED at 0.1x input (Anthropic's usual cache-read discount).
//   - cache_write: ASSUMED at 1.25x input (the 5-minute cache TTL); a 1-hour TTL write costs more.
//   - Haiku 5.5: $0.10 / $0.50 for prompts up to 100K tokens, $0.50 / $2.50 beyond (applied per call).
//   - A model not in the table is charged at FALLBACK (the most expensive listed tier) and reported
//     as unpriced, so an unknown id can only overstate the cost, never hide it.
// Override for a run: HAGGLE_AI_PRICES='{"claude-sonnet-5-5":{"input":2,"output":10}}' (merged over the table).

export interface ModelPrice {
  input: number;
  output: number;
  /** Absent: 1.25x input. */
  cache_write?: number;
  /** Absent: 0.1x input. */
  cache_read?: number;
  /** Prompts over this many input tokens use `long`. */
  long_context_over?: number;
  long?: { input: number; output: number };
}

export const PRICING_SOURCE = "Claude API model table (claude-api skill, cached 2026-10-06; checked 2026-10-22)";

export const MODEL_PRICES_USD_PER_MTOK: Record<string, ModelPrice> = {
  "claude-fable-5-1": { input: 10, output: 50, cache_read: 0.25 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, long_context_over: 100_000, long: { input: 0.5, output: 2.5 } },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
export const FALLBACK_MODEL_PRICE: ModelPrice = { input: 10, output: 50 };

export interface UsageTokens { model: string; input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }

/** Merge a JSON override ({model: {input, output, ...}}) over the table; invalid entries are refused. */
export function pricesWithOverride(json: string | undefined, base: Record<string, ModelPrice> = MODEL_PRICES_USD_PER_MTOK): Record<string, ModelPrice> {
  if (!json?.trim()) return base;
  const parsed = JSON.parse(json) as Record<string, Partial<ModelPrice>>;
  const out = { ...base };
  for (const [model, p] of Object.entries(parsed)) {
    const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
    if (!ok(p.input) || !ok(p.output) || (p.cache_read !== undefined && !ok(p.cache_read)) || (p.cache_write !== undefined && !ok(p.cache_write))) throw new Error(`HAGGLE_AI_PRICES: ${model} needs numeric input and output (USD per million tokens)`);
    out[model] = p as ModelPrice;
  }
  return out;
}

/** One call's approximate cost in USD, and whether its model was priced. */
export function callCostUsd(u: UsageTokens, prices: Record<string, ModelPrice> = MODEL_PRICES_USD_PER_MTOK): { usd: number; priced: boolean } {
  const p = prices[u.model];
  const base = p ?? FALLBACK_MODEL_PRICE;
  const prompt = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  const tier = base.long && base.long_context_over !== undefined && prompt > base.long_context_over ? base.long : base;
  const cw = base.cache_write ?? tier.input * 1.25;
  const cr = base.cache_read ?? tier.input * 0.1;
  const usd = (u.input_tokens * tier.input + u.output_tokens * tier.output + u.cache_creation_input_tokens * cw + u.cache_read_input_tokens * cr) / 1_000_000;
  return { usd, priced: !!p };
}

export interface CostSummary {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  approx_usd: number;
  by_model: Record<string, { calls: number; input_tokens: number; output_tokens: number; approx_usd: number; priced: boolean }>;
  unpriced_models: string[];
}

export function summarizeCost(rows: UsageTokens[], prices: Record<string, ModelPrice> = MODEL_PRICES_USD_PER_MTOK): CostSummary {
  const s: CostSummary = { calls: 0, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, approx_usd: 0, by_model: {}, unpriced_models: [] };
  for (const r of rows) {
    const c = callCostUsd(r, prices);
    s.calls++;
    s.input_tokens += r.input_tokens;
    s.output_tokens += r.output_tokens;
    s.cache_creation_input_tokens += r.cache_creation_input_tokens;
    s.cache_read_input_tokens += r.cache_read_input_tokens;
    s.approx_usd += c.usd;
    const m = (s.by_model[r.model] ??= { calls: 0, input_tokens: 0, output_tokens: 0, approx_usd: 0, priced: c.priced });
    m.calls++;
    m.input_tokens += r.input_tokens + r.cache_creation_input_tokens + r.cache_read_input_tokens;
    m.output_tokens += r.output_tokens;
    m.approx_usd += c.usd;
  }
  s.unpriced_models = Object.entries(s.by_model).filter(([, m]) => !m.priced).map(([k]) => k).sort();
  s.approx_usd = round6(s.approx_usd);
  for (const m of Object.values(s.by_model)) m.approx_usd = round6(m.approx_usd);
  return s;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
