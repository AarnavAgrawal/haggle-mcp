// Engine rows <-> frozen contract types (packages/core/contracts.ts).
import type { ParsedReply, Quote, QuoteField, QuoteFlag, Request, Requirement } from "../contract.ts";
import { centsToUsd } from "../money.ts";
import type { QuoteExtraction } from "../parsing/extraction.ts";
import type { EngineRequirement } from "../parsing/requirements.ts";
import type { JobBusinessRow, QuoteRow } from "../store/types.ts";

const DIETS = ["vegetarian", "vegan", "gluten-free", "gluten free", "halal", "kosher", "dairy-free", "nut-free", "pescatarian"];

/** Contract Requirement -> engine requirement (the dietary need is read from the text). */
export function toEngineRequirement(r: Requirement): EngineRequirement {
  if (r.kind !== "dietary") return { ...r };
  const t = r.text.toLowerCase();
  const need = DIETS.find((d) => t.includes(d))?.replace(" ", "-");
  return { ...r, ...(need ? { need } : {}) };
}

const CONTRACT_FLAGS: ReadonlySet<QuoteFlag> = new Set<QuoteFlag>([
  "requirement_unmet", "requirement_unknown", "hidden_deposit", "hidden_fee", "tax_excluded", "delivery_unclear", "vague_price",
  "conflicting_numbers", "expired", "external_payment_link", "prompt_injection", "unverified_sender", "over_budget", "low_confidence",
  "question_pending", "unsourced_figure", "approximate_total",
]);

export function quoteFlags(q: QuoteRow, budgetCents: number | null): QuoteFlag[] {
  const flags = new Set<QuoteFlag>(q.record.flags.filter((f): f is QuoteFlag => CONTRACT_FLAGS.has(f as QuoteFlag)));
  if (q.requirement_results.some((r) => r.met === false)) flags.add("requirement_unmet");
  if (q.requirement_results.some((r) => r.met === null)) flags.add("requirement_unknown");
  if (!q.sender_trusted) flags.add("unverified_sender");
  if (q.total_cents === null) flags.add("vague_price");
  if (budgetCents !== null && q.total_cents !== null && q.total_cents > budgetCents) flags.add("over_budget");
  return [...flags];
}

const MISSING_TO_FIELD: Record<string, QuoteField | undefined> = {
  total: "total_usd", deposit: "deposit_usd", delivery_fee: "delivery_usd", delivery: "delivery_usd", tax: "tax_usd",
  price_per_head: "per_unit_usd", valid_until: "valid_until", headcount_mismatch: "quantity",
};

const usd = (c: number | null) => (c === null ? undefined : centsToUsd(c));

export function toContractQuote(q: QuoteRow, b: JobBusinessRow, opts: { budgetCents: number | null; negotiatedFromCents?: number; price_check?: Quote["price_check"] }): Quote {
  const missing = new Set<string>(q.record.missing_fields);
  const evidence: Quote["evidence"] = {};
  const map = { total: "total_usd", deposit: "deposit_usd", delivery_fee: "delivery_usd", tax: "tax_usd", price_per_head: "per_unit_usd" } as const;
  for (const [k, field] of Object.entries(map)) {
    const s = q.record.sources[k as keyof typeof map];
    if (s) evidence[field] = { provenance: "stated", source: s.source, excerpt: s.excerpt };
  }
  const quote: Quote = {
    kind: "quote",
    quote_id: q.id,
    job_id: q.job_id,
    business_id: q.business_id,
    business: b.name,
    total_usd: usd(q.total_cents) ?? 0,
    items: q.record.menu_items.slice(0, 8),
    meets_requirements: q.compliant,
    requirement_results: q.requirement_results.map((r) => ({ requirement_id: r.requirement_id, met: r.met })),
    missing: [...new Set([...missing].map((m) => MISSING_TO_FIELD[m]).filter((f): f is QuoteField => f !== undefined))],
    flags: quoteFlags(q, opts.budgetCents),
    round: q.round,
    confidence: Math.round(q.record.confidence * 100) / 100,
    source: q.source,
    evidence,
    status: q.status,
    message_id: q.message_id,
  };
  if (q.total_cents === null && !quote.missing.includes("total_usd")) quote.missing.push("total_usd");
  const pp = usd(q.record.price_per_head_cents);
  if (pp !== undefined) quote.per_unit_usd = pp;
  const dep = usd(q.deposit_cents);
  if (dep !== undefined) quote.deposit_usd = dep;
  const del = usd(q.record.delivery_fee_cents);
  if (del !== undefined) quote.delivery_usd = del;
  const tax = usd(q.record.tax_cents);
  if (tax !== undefined) quote.tax_usd = tax;
  if (q.record.valid_until) quote.valid_until = q.record.valid_until;
  if (opts.negotiatedFromCents !== undefined) quote.negotiated_from = centsToUsd(opts.negotiatedFromCents);
  if (opts.price_check) quote.price_check = opts.price_check;
  return quote;
}

/** Validated extraction -> contract ParsedReply for brain.learnFromReply. */
export function toParsedReply(x: QuoteExtraction, quote: Quote | null, questionIds: string[]): ParsedReply {
  const items: ParsedReply["items"] = [];
  if (quote) {
    const { quote_id: _a, price_check: _b, status: _c, ...rest } = quote;
    items.push({ kind: "quote", quote: rest });
  }
  x.questions.forEach((text, i) => items.push({ kind: "question", question_id: questionIds[i] ?? `q${i}`, text, blocks_quote: quote === null }));
  if (!x.available) items.push({ kind: "decline" });
  if (x.payment_request !== "none") items.push({ kind: "payment_request", rail: "external_link" });
  if (items.length === 0) items.push({ kind: "status", status: "need_more_info" });
  return { items, injection_detected: x.instructions_to_agent };
}

export function requestHeadcount(r: Request): number {
  return r.quantity;
}
