// PURE: does a validated quote meet the buyer's requirements?
//
// Claude judges each requirement from the conversation (QuoteRecord.requirement_checks, with the
// business's own words as evidence). This file only adds what code does better than a model:
//   - arithmetic on stated numbers ("6 vegetarian" against "at least 12", a headcount below the
//     order) can turn a yes into a no, never the other way round;
//   - facts of the request itself (the date, the place, the headcount the RFQ named) count as
//     accepted when the business quotes for that request without contradicting them;
//   - with no judgement at all (the keyword fallback, quote.json, old records) the keyword rules
//     below decide, conservatively: `met: null` means the business didn't say, which is a
//     follow-up, never an assumed yes.
// Engine-internal requirement shape; mirrors the contract `Requirement`.
import type { QuoteRecord } from "./extraction.ts";
import { canonicalNeed } from "./validate.ts";

export interface EngineRequirement {
  id: string;
  kind: "dietary" | "quantity" | "delivery" | "date" | "location" | "service" | "other";
  text: string;
  hard: boolean;
  /** For dietary: the need ("vegetarian"); for quantity: unused. */
  need?: string;
  min_count?: number;
}

/** Where a verdict came from: Claude's reading, a stated number, an uncontradicted request fact, or the keyword fallback. */
export type RequirementBasis = "claude" | "arithmetic" | "request_fact" | "keyword";

export interface RequirementResult {
  requirement_id: string;
  met: boolean | null;
  reason: string;
  /** The business's words behind the verdict, when there are any. */
  evidence?: string;
  basis?: RequirementBasis;
}

/** Requirement kinds that only restate the request (the RFQ named them); quoting for the request accepts them. */
const REQUEST_FACT_KINDS = new Set<EngineRequirement["kind"]>(["date", "location", "quantity"]);

function dietaryEntry(q: QuoteRecord, need: string | undefined) {
  if (!need) return undefined;
  const n = need.trim().toLowerCase();
  if (q.dietary_coverage[n]) return q.dietary_coverage[n];
  // Older records keyed by the business's wording ("20 vegetarian").
  for (const [k, v] of Object.entries(q.dietary_coverage)) if (canonicalNeed(k, [n]) === n) return v;
  return undefined;
}

/** A verdict from stated numbers only (null when no number decides it). */
function arithmetic(q: QuoteRecord, r: EngineRequirement, requestedHeadcount: number | undefined): RequirementResult | null {
  if (r.kind === "dietary" && r.min_count !== undefined) {
    const d = dietaryEntry(q, r.need);
    if (d?.count_offered == null) return null;
    return d.count_offered >= r.min_count
      ? { requirement_id: r.id, met: true, reason: `${d.count_offered} offered`, basis: "arithmetic" }
      : { requirement_id: r.id, met: false, reason: `only ${d.count_offered} of ${r.min_count}`, basis: "arithmetic" };
  }
  if (r.kind === "quantity") {
    const need = requestedHeadcount ?? r.min_count;
    if (need === undefined || q.headcount === null) return null;
    return q.headcount >= need
      ? { requirement_id: r.id, met: true, reason: `${q.headcount} guests`, basis: "arithmetic" }
      : { requirement_id: r.id, met: false, reason: `quoted for ${q.headcount}, need ${need}`, basis: "arithmetic" };
  }
  return null;
}

/** Quoting for our request (available, with a price) without contradicting a fact of it accepts that fact. */
function acceptsRequestFacts(q: QuoteRecord): boolean {
  return q.available && (q.total_cents !== null || q.subtotal_cents !== null || q.price_per_head_cents !== null);
}

/** The keyword rules: used only when Claude gave no judgement for this requirement. */
function keyword(q: QuoteRecord, r: EngineRequirement): RequirementResult {
  const res = (met: boolean | null, reason: string): RequirementResult => ({ requirement_id: r.id, met, reason, basis: "keyword" });
  switch (r.kind) {
    case "dietary": {
      const d = dietaryEntry(q, r.need);
      if (!d) return res(null, "not stated");
      if (!d.covered) return res(false, "business said it can't cover it");
      if (r.min_count === undefined) return res(true, "covered");
      return res(null, "covered, count not stated");
    }
    case "delivery":
      if (q.delivery_included === true || q.delivery_fee_cents !== null) return res(true, "delivery priced or included");
      if (q.delivery_included === false) return res(false, "delivery not offered");
      return res(null, "delivery not stated");
    default:
      return res(null, "needs review");
  }
}

export function evaluateRequirements(q: QuoteRecord, reqs: EngineRequirement[], requestedHeadcount: number | undefined): RequirementResult[] {
  return reqs.map((r): RequirementResult => {
    const check = q.requirement_checks?.[r.id];
    const math = arithmetic(q, r, requestedHeadcount);
    // A stated number below the requirement is a no, whatever the wording around it.
    if (math?.met === false) return math;
    if (check && check.met !== null) {
      return {
        requirement_id: r.id, met: check.met, basis: "claude",
        reason: (check.note || (check.met ? "the business confirmed it" : "the business can't meet it")) + (check.carried ? " (earlier reply)" : ""),
        ...(check.evidence ? { evidence: check.evidence } : {}),
      };
    }
    if (math) return math;
    if (REQUEST_FACT_KINDS.has(r.kind) && acceptsRequestFacts(q)) {
      return { requirement_id: r.id, met: true, reason: "quoted for the request as sent; not contradicted", basis: "request_fact" };
    }
    if (check) {
      // Claude read the conversation and found nothing on it: unknown (a follow-up), unless the
      // keyword rules have a stated fact (a delivery fee, a declined need) to go on.
      const k = keyword(q, r);
      return k.met !== null && !(r.kind === "dietary" && k.met === false) ? k : { requirement_id: r.id, met: null, reason: "not addressed by the business", basis: "claude" };
    }
    return keyword(q, r);
  });
}

/** Compliant only when every hard requirement is met === true. */
export function meetsHardRequirements(results: RequirementResult[], reqs: EngineRequirement[]): boolean {
  const hard = new Set(reqs.filter((r) => r.hard).map((r) => r.id));
  return results.filter((r) => hard.has(r.requirement_id)).every((r) => r.met === true);
}
