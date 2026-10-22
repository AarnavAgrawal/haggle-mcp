// PURE: does a quote meet everything the buyer made a must? Ranking (rank.ts) keeps every safe quote
// visible and the human may knowingly approve any of them; this decides whether a quote may WIN on its
// own: be Haggle's recommendation or the "all quotes are in" suggestion texted for a YES. Only a
// "compliant" quote can. A hard requirement the business didn't answer is "unconfirmed", never
// assumed met; a stated miss, a total over the buyer's budget, or a pay-now amount over the spending
// cap is "noncompliant".
//
// Request facts (date, place, headcount) that the business quoted for without contradicting count as
// met here (requirements.ts "request_fact"), because the RFQ named them; they are marked `assumed`,
// and a deal is only "booked" once the business explicitly confirms them after acceptance.
import type { EngineRequirement, RequirementResult } from "../parsing/requirements.ts";

export type ComplianceStatus = "compliant" | "unconfirmed" | "noncompliant";

export type ComplianceCode = "requirement_unmet" | "requirement_unconfirmed" | "over_budget" | "over_limit" | "pay_now_over_cap" | "no_total";

export interface ComplianceIssue {
  code: ComplianceCode;
  /** One line for the human, e.g. "only 6 of 12 vegetarian". */
  text: string;
  requirement_id?: string;
}

export interface Compliance {
  status: ComplianceStatus;
  issues: ComplianceIssue[];
  /** Hard requirements counted as met only because the business quoted for the request as sent. */
  assumed: string[];
}

export interface ComplianceInput {
  requirements: EngineRequirement[];
  results: RequirementResult[];
  totalCents: number | null;
  /** What approval would pay now: the deposit, or the full total when none was stated. */
  payNowCents: number | null;
  budgetCents: number | null;
  budgetKind?: "target" | "limit";
  /** The lowest of the job, server and workspace caps; null = no cap to check. */
  capCents: number | null;
}

const usd = (c: number) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function assessCompliance(i: ComplianceInput): Compliance {
  const issues: ComplianceIssue[] = [];
  const assumed: string[] = [];
  const results = new Map(i.results.map((r) => [r.requirement_id, r]));
  for (const req of i.requirements.filter((r) => r.hard)) {
    const r = results.get(req.id);
    if (!r || r.met === null) issues.push({ code: "requirement_unconfirmed", text: `not confirmed: ${req.text}`, requirement_id: req.id });
    else if (r.met === false) issues.push({ code: "requirement_unmet", text: `doesn't meet: ${req.text}${r.reason ? ` (${r.reason})` : ""}`, requirement_id: req.id });
    else if (r.basis === "request_fact") assumed.push(req.text);
  }
  if (i.totalCents === null) issues.push({ code: "no_total", text: "no total stated" });
  else if (i.budgetCents !== null && i.totalCents > i.budgetCents) {
    issues.push(i.budgetKind === "limit"
      ? { code: "over_limit", text: `${usd(i.totalCents - i.budgetCents)} over the ${usd(i.budgetCents)} limit` }
      : { code: "over_budget", text: `${usd(i.totalCents - i.budgetCents)} over the ${usd(i.budgetCents)} budget` });
  }
  if (i.payNowCents !== null && i.capCents !== null && i.payNowCents > i.capCents) issues.push({ code: "pay_now_over_cap", text: `${usd(i.payNowCents)} due now is over the ${usd(i.capCents)} spending cap` });
  const status: ComplianceStatus = issues.some((x) => x.code !== "requirement_unconfirmed" && x.code !== "no_total") ? "noncompliant" : issues.length ? "unconfirmed" : "compliant";
  return { status, issues, assumed };
}

/** "only 6 of 12 vegetarian; $200 over the $5,000 budget" (first few issues, for texts and hints). */
export function complianceSummary(c: Compliance, max = 2): string {
  const shown = c.issues.slice(0, max).map((x) => x.text);
  return shown.join("; ") + (c.issues.length > max ? ` (+${c.issues.length - max} more)` : "");
}
