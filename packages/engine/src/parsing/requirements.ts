// PURE: does a validated quote meet the buyer's hard requirements?
// `met: null` means the business didn't say; that is a follow-up, never an assumed yes.
// Engine-internal requirement shape; mirrors the proposed contract `Requirement`.
import type { QuoteRecord } from "./extraction.ts";

export interface EngineRequirement {
  id: string;
  kind: "dietary" | "quantity" | "delivery" | "date" | "location" | "service" | "other";
  text: string;
  hard: boolean;
  /** For dietary: the need ("vegetarian"); for quantity: unused. */
  need?: string;
  min_count?: number;
}

export interface RequirementResult {
  requirement_id: string;
  met: boolean | null;
  reason: string;
}

export function evaluateRequirements(q: QuoteRecord, reqs: EngineRequirement[], requestedHeadcount: number): RequirementResult[] {
  return reqs.map((r): RequirementResult => {
    switch (r.kind) {
      case "dietary": {
        const d = q.dietary_coverage[(r.need ?? "").trim().toLowerCase()];
        if (!d) return { requirement_id: r.id, met: null, reason: "not stated" };
        if (!d.covered) return { requirement_id: r.id, met: false, reason: "business said it can't cover it" };
        if (r.min_count === undefined) return { requirement_id: r.id, met: true, reason: "covered" };
        if (d.count_offered === null) return { requirement_id: r.id, met: null, reason: "covered, count not stated" };
        return d.count_offered >= r.min_count
          ? { requirement_id: r.id, met: true, reason: `${d.count_offered} offered` }
          : { requirement_id: r.id, met: false, reason: `only ${d.count_offered} of ${r.min_count}` };
      }
      case "delivery":
        if (q.delivery_included === true || q.delivery_fee_cents !== null) return { requirement_id: r.id, met: true, reason: "delivery priced or included" };
        if (q.delivery_included === false) return { requirement_id: r.id, met: false, reason: "delivery not offered" };
        return { requirement_id: r.id, met: null, reason: "delivery not stated" };
      case "quantity":
        if (q.headcount === null) return { requirement_id: r.id, met: null, reason: "headcount not stated" };
        return q.headcount >= requestedHeadcount
          ? { requirement_id: r.id, met: true, reason: `${q.headcount} guests` }
          : { requirement_id: r.id, met: false, reason: `quoted for ${q.headcount}, need ${requestedHeadcount}` };
      default: {
        // Any other requirement (licensing, insurance, timing, service scope…): only the business's
        // own explicit answer counts, with its words as the reason.
        const a = q.requirement_answers?.[r.text.trim().toLowerCase()];
        if (!a) return { requirement_id: r.id, met: null, reason: "not stated" };
        // "Total must include delivery/fees": a business that lists the extra separately is answered by the
        // all-in total Haggle computed from those stated parts (never a guess).
        if (!a.met && /\b(all[- ]?in|includ\w*\b.*\b(delivery|fees?|tax|charges))\b/i.test(r.text) && /^computed from stated/.test(q.sources.total?.source ?? "")) {
          return { requirement_id: r.id, met: true, reason: `all-in total computed from the stated parts (${q.sources.total!.excerpt})` };
        }
        return { requirement_id: r.id, met: a.met, reason: a.met ? `business said: "${a.excerpt}"` : `business said it can't: "${a.excerpt}"` };
      }
    }
  });
}

/** Compliant only when every hard requirement is met === true. */
export function meetsHardRequirements(results: RequirementResult[], reqs: EngineRequirement[]): boolean {
  const hard = new Set(reqs.filter((r) => r.hard).map((r) => r.id));
  return results.filter((r) => hard.has(r.requirement_id)).every((r) => r.met === true);
}
