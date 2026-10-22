// PURE: why each quote on a deal was selected, or why it can't be. One short line per quote, from the
// same facts the board already decides with (approval block, compliance, freshness, status), so the
// agent and the human see the reason instead of inferring it from flags. Order matters: the first
// reason that stops a quote is the one shown (a superseded or unsafe quote isn't also "over budget").
//
// "recommended": Haggle's pick (current, approvable, compliant, fresh, best value among those).
// "selectable": the human may approve it knowingly, but it isn't Haggle's pick (ranked lower, or a
//   caveat: unconfirmed or unmet must, over budget). Never texted for a YES by Haggle.
// "not_selectable": can't be approved as is (superseded, unsafe, no firm total, stale until re-confirmed).
import { complianceSummary, type Compliance } from "./compliance.ts";

export type SelectionStatus = "recommended" | "selectable" | "not_selectable";

export interface QuoteSelection {
  status: SelectionStatus;
  /** One line, ≤ 160 chars, e.g. "doesn't meet: At least 12 vegetarian meals (only 6 of 12)". */
  reason: string;
}

export interface SelectionFacts {
  current: boolean;
  /** A safety refusal or a business that declined (the board's verdict "rejected"). */
  rejected?: string | null;
  approvalBlock?: { code: string; reason: string } | null;
  compliance?: Compliance | null;
  freshness?: { stale: boolean; reason?: "expired" | "aged"; valid_until: string | null; reconfirmation?: "requested" } | null;
  /** The board's recommended quote id equals this quote. */
  recommended: boolean;
  /** The recommended quote's business, when another quote is recommended. */
  recommendedBusiness?: string | null;
}

const clip = (s: string, n = 160) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export function selectionOf(f: SelectionFacts): QuoteSelection {
  const no = (reason: string): QuoteSelection => ({ status: "not_selectable", reason: clip(reason) });
  if (!f.current) return no("superseded by a newer quote from this business");
  if (f.rejected) return no(`can't win: ${f.rejected}`);
  if (f.approvalBlock) return no(`can't be approved yet: ${f.approvalBlock.reason}`);
  if (f.freshness?.stale) {
    const why = f.freshness.reason === "expired" ? `past its valid-until date${f.freshness.valid_until ? ` (${f.freshness.valid_until.slice(0, 10)})` : ""}` : "older than the quote validity window";
    return no(`stale: ${why}; ${f.freshness.reconfirmation ? "re-confirmation requested from the business" : "approving it first asks the business to re-confirm"}`);
  }
  const c = f.compliance;
  if (c && c.status !== "compliant") return { status: "selectable", reason: clip(`${c.status === "noncompliant" ? "misses a must" : "unconfirmed must"}: ${complianceSummary(c, 2)} (only if the user knowingly chooses it)`) };
  if (f.recommended) return { status: "recommended", reason: "recommended: meets every requirement and the budget, fresh, best value of the quotes that can be approved" };
  return { status: "selectable", reason: clip(`meets every requirement, but ranked below ${f.recommendedBusiness ?? "the recommended quote"} on value`) };
}
