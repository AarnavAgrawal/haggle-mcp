// The opt-in real-Anthropic eval runner's spending cap (sprint 4, E). A live run needs ALL of
// HAGGLE_EVAL_LIVE=1, ANTHROPIC_API_KEY and HAGGLE_EVAL_MAX_USD (a positive dollar cap); without the cap
// it refuses. Every Claude call is admitted first against a conservative cost estimate (input tokens
// counted from the request, output at max_tokens) and refused if it could cross the cap; afterwards the
// response's reported usage is charged (or the estimate, if no usage came back).
//
// ASSUMPTIONS (documented, deliberately conservative; check them against the current price list before a run):
// - Prices, USD per million tokens, Anthropic first-party API (cached list 2026-10-06): see PRICE_USD_PER_MTOK.
//   An unknown model is charged at FALLBACK_PRICE (the most expensive tier listed).
// - Haiku 5.5 is charged at its >100K-token-prompt price ($0.50 / $2.50) for every call.
// - Cache writes are charged at 1.25x input and cache reads at full input price (never discounted).
// - Input tokens are estimated at 1 token per 3 characters of the serialized request (system prompt,
//   messages, output schema), with base64 payloads replaced by: 3,000 tokens per PDF page (pages
//   counted in the decoded PDF, at least 1) and 2,000 tokens per image. Real counts are usually lower.
// - Output is reserved at the call's max_tokens.
import Anthropic from "@anthropic-ai/sdk";

export interface Price { input: number; output: number }

export const PRICE_USD_PER_MTOK: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.5, output: 2.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
export const FALLBACK_PRICE: Price = { input: 10, output: 50 };
export const priceFor = (model: string): Price => PRICE_USD_PER_MTOK[model] ?? FALLBACK_PRICE;

const TOKENS_PER_PDF_PAGE = 3_000;
const TOKENS_PER_IMAGE = 2_000;
const CHARS_PER_TOKEN = 3;

export type LiveConfig =
  | { ok: true; apiKey: string; model: string; maxUsd: number; workspaceId?: string }
  | { ok: false; reason: string };

/** The live runner's switches, read from `env`. Never returns ok without a positive cap. */
export function liveEvalConfig(env: Record<string, string | undefined>): LiveConfig {
  if (env.HAGGLE_EVAL_LIVE !== "1") return { ok: false, reason: "HAGGLE_EVAL_LIVE is not 1 (the live Claude eval is opt-in)" };
  if (!env.ANTHROPIC_API_KEY) return { ok: false, reason: "ANTHROPIC_API_KEY is not set" };
  const cap = Number(env.HAGGLE_EVAL_MAX_USD);
  if (!env.HAGGLE_EVAL_MAX_USD || !Number.isFinite(cap) || cap <= 0) return { ok: false, reason: "HAGGLE_EVAL_MAX_USD must be a positive dollar cap (e.g. 2.00); the live eval refuses to run without one" };
  return { ok: true, apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5", maxUsd: cap, ...(env.ANTHROPIC_WORKSPACE_ID ? { workspaceId: env.ANTHROPIC_WORKSPACE_ID } : {}) };
}

export class EvalBudgetExceeded extends Error {
  override name = "EvalBudgetExceeded";
}

function pdfPages(b64: string): number {
  const text = Buffer.from(b64, "base64").toString("latin1");
  return Math.max(1, (text.match(/\/Type\s*\/Page(?!s)/g) ?? []).length);
}

/** Conservative input-token estimate for one messages.parse/create request body. */
export function estimateInputTokens(params: unknown): number {
  let media = 0;
  const json = JSON.stringify(params, (_k, v: unknown) => {
    if (v && typeof v === "object" && (v as { type?: string }).type === "base64" && typeof (v as { data?: unknown }).data === "string") {
      const src = v as { media_type?: string; data: string };
      media += src.media_type === "application/pdf" ? pdfPages(src.data) * TOKENS_PER_PDF_PAGE : TOKENS_PER_IMAGE;
      return { type: "base64", media_type: src.media_type, data: "" };
    }
    return v;
  });
  return Math.ceil(json.length / CHARS_PER_TOKEN) + media;
}

type Usage = { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };

export class EvalBudget {
  spentUsd = 0;
  reservedUsd = 0;
  calls = 0;
  refused = 0;
  inputTokens = 0;
  outputTokens = 0;
  constructor(readonly maxUsd: number, readonly model: string, readonly price: Price = priceFor(model)) {
    if (!(maxUsd > 0)) throw new Error("EvalBudget needs a positive cap");
  }
  cost(input: number, output: number): number { return (input * this.price.input + output * this.price.output) / 1_000_000; }
  /** Reserves the worst case for one call; throws (nothing is sent) if it could cross the cap. */
  admit(params: { max_tokens?: number }): number {
    const est = this.cost(estimateInputTokens(params), params.max_tokens ?? 4_096);
    if (this.spentUsd + this.reservedUsd + est > this.maxUsd) {
      this.refused++;
      throw new EvalBudgetExceeded(`live eval cap $${this.maxUsd.toFixed(2)} reached (spent $${this.spentUsd.toFixed(4)}, this call could cost up to $${est.toFixed(4)})`);
    }
    this.reservedUsd += est;
    return est;
  }
  /** Releases the reservation and charges the reported usage (or the reservation when none came back). */
  settle(reserved: number, usage: Usage | null | undefined): void {
    this.reservedUsd -= reserved;
    this.calls++;
    if (!usage) { this.spentUsd += reserved; return; }
    const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + 1.25 * (usage.cache_creation_input_tokens ?? 0);
    const output = usage.output_tokens ?? 0;
    this.inputTokens += input;
    this.outputTokens += output;
    this.spentUsd += this.cost(input, output);
  }
}

type ParseFn = (params: never, ...rest: never[]) => Promise<unknown>;

/** Wraps a client's messages.parse with the budget (admit before, settle after; a failed call is charged its reservation). */
export function budgetedClient<C extends { messages: { parse: ParseFn } }>(client: C, budget: EvalBudget): C {
  const parse = client.messages.parse.bind(client.messages) as unknown as (p: unknown, ...r: unknown[]) => Promise<unknown>;
  const messages = new Proxy(client.messages, {
    get(target, prop, receiver) {
      if (prop !== "parse") return Reflect.get(target, prop, receiver);
      return async (p: { max_tokens?: number }, ...rest: unknown[]) => {
        const reserved = budget.admit(p);
        let res: unknown;
        try {
          res = await parse(p, ...rest);
        } catch (e) {
          budget.settle(reserved, null);
          throw e;
        }
        budget.settle(reserved, (res as { usage?: Usage } | null)?.usage);
        return res;
      };
    },
  });
  return new Proxy(client, { get: (t, prop, r) => (prop === "messages" ? messages : Reflect.get(t, prop, r)) });
}

/**
 * The real Anthropic client for a live run, built with the fetch that exists NOW (the eval env later
 * traps globalThis.fetch to catch followed vendor links), wrapped in the budget.
 */
export function liveAnthropicClient(cfg: Extract<LiveConfig, { ok: true }>, budget: EvalBudget): Anthropic {
  const realFetch = globalThis.fetch.bind(globalThis);
  const client = new Anthropic({ apiKey: cfg.apiKey, timeout: 60_000, maxRetries: 2, fetch: realFetch, ...(cfg.workspaceId ? { defaultHeaders: { "anthropic-workspace-id": cfg.workspaceId } } : {}) });
  return budgetedClient(client, budget);
}
