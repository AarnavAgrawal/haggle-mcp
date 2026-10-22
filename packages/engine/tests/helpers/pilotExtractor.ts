// Deterministic stand-in for Claude in the pilot purchasing tests (no model call).
import type { ExtractorPort } from "../../src/index.ts";
import { vendorOwnWords } from "../../src/approvals/bookingReply.ts";

/** Reads "$X total", "$Y deposit", "N vegetarian", "delivered by HH:MM" from the vendor's own words (email, text or call transcript). */
export const pilotExtractor: ExtractorPort = {
  async extract(i) {
    // A text reply comes with Haggle's last text for context: only the business's own words are read.
    const t = vendorOwnWords(i.bodyText.split("[The business's reply]: ").at(-1)!);
    const money = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
    const total = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*(?:all[- ]in\s*)?total/i) ?? money(/total[^$\d]{0,20}\$\s?([\d,]+(?:\.\d{2})?)/i);
    const deposit = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*deposit/i);
    const veg = t.match(/(\d+)\s*(?:vegetarian|veg\b)/i);
    const by = /deliver\w*[^.\n]{0,40}\bby (\d{1,2}:\d{2})/i.exec(t);
    const questions = t.split(/(?<=[.!?])\s+/).filter((s) => s.trim().endsWith("?")).map((text) => ({ text: text.trim(), needs_answer_to_quote: true }));
    const checks = (i.request.requirementList ?? []).map((r) => {
      if (r.kind === "dietary") return veg ? { requirement_id: r.id, met: Number(veg[1]) >= (r.min_count ?? 0), evidence: veg[0], note: `offered ${veg[1]}` } : { requirement_id: r.id, met: null, evidence: "", note: "not stated" };
      if (r.kind === "delivery") return by ? { requirement_id: r.id, met: by[1]!.padStart(5, "0") <= "11:30", evidence: by[0], note: `by ${by[1]}` } : { requirement_id: r.id, met: null, evidence: "", note: "not stated" };
      return { requirement_id: r.id, met: null, evidence: "", note: "not addressed" };
    });
    return {
      available: !/\b(can't|cannot|unable to)\b/i.test(t), price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: /deliver/i.test(t) ? true : null,
      tax_usd: null, tax_status: /tax incl|including tax|tax included/i.test(t) ? "included" : "not_mentioned", tax_rate_percent: null, tax_evidence: "", total_usd: total, deposit_usd: deposit, menu_items: [],
      dietary_coverage: veg ? [{ need: "vegetarian", covered: true, count_offered: Number(veg[1]) }] : [], valid_until: /valid until (\d{4}-\d{2}-\d{2})/i.exec(t)?.[1] ?? null, questions, payment_request: "none", instructions_to_agent: false,
      sources: [...(total !== null ? [{ field: "total" as const, source: "email body", excerpt: `$${total} total` }] : []), ...(deposit !== null ? [{ field: "deposit" as const, source: "email body", excerpt: `$${deposit} deposit` }] : [])], missing_fields: total === null ? ["total"] : [], confidence: 0.9, requirement_checks: checks,
    } as never;
  },
};
