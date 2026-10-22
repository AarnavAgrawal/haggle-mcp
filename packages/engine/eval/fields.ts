// Per-field evaluation (sprint 4, E). Each labelled reply is scored field by field (business identity,
// quoted total, tax, fees, delivery, date/time, deposit, each hard requirement), and money errors are
// counted SEPARATELY from accuracy: a money error is a wrong dollar amount Haggle would show the human
// on the board (`shown`), and the subset it would also let them approve (`approvable`). A missing
// amount is not a money error (it is shown as "not stated" and blocks approval); a wrong one is.
import type { CorpusCase } from "./types.ts";

export type FieldVerdict = "correct" | "missing" | "wrong" | "n/a";

export const FIELDS = ["identity", "total", "tax", "fees", "delivery", "date", "deposit", "req_veg", "req_delivery"] as const;
export type Field = (typeof FIELDS)[number];

/** What the engine stored and showed for one reply (the subset per-field scoring needs). */
export interface FieldObservation {
  total_usd: number | null;
  deposit_usd: number | null;
  delivery: boolean | null;
  tax: "included" | "added_on_top" | "not_mentioned" | null;
  /** Fees the engine recorded (delivery fee + other fees), amounts in USD. */
  fees: { label: string; amount_usd: number | null; included: boolean | null }[];
  /** The engine's verdict on the requested date/time: false only when it recorded the business as unavailable. */
  date_ok: boolean | null;
  /** Hard-requirement verdicts as stored (null = not judged). */
  requirements: Record<string, boolean | null>;
  flags: string[];
  /** What the board shows (null = no priced quote on the board) and whether the human could approve it. */
  shown_total_usd: number | null;
  shown_deposit_usd: number | null;
  approvable: boolean;
}

export interface FieldScore {
  id: string;
  fields: Record<Field, FieldVerdict>;
  /** A wrong amount on the board: the total (or a total shown without a caveat where none is firm), or the deposit. */
  money_error_shown: string[];
  /** ...that the human could also approve. */
  money_error_approvable: string[];
}

const close = (a: number, b: number) => Math.abs(a - b) < 0.011;
/** Flags that tell the human the shown total isn't a firm all-in figure. */
export const CAVEAT_FLAGS = new Set(["tax_excluded", "fees_unclear", "approximate_total", "conflicting_numbers", "delivery_unclear"]);
/** No engine flag says "the reply names another business"; listed here so a future one is picked up. */
const IDENTITY_FLAGS = new Set(["identity_mismatch", "vendor_mismatch", "sender_name_mismatch"]);

const PRICED = new Set(["quote", "unsafe_payment", "unsafe_injection"]);

export function scoreFields(c: CorpusCase, o: FieldObservation): FieldScore {
  const l = c.labels;
  const priced = PRICED.has(l.outcome);
  const num = (label: number | null, got: number | null): FieldVerdict => (label === null ? "n/a" : got === null ? "missing" : close(got, label) ? "correct" : "wrong");
  const bool = (label: boolean | null | undefined, got: boolean | null): FieldVerdict => (label === null || label === undefined ? "n/a" : got === null ? "missing" : got === label ? "correct" : "wrong");
  const caveated = o.flags.some((f) => CAVEAT_FLAGS.has(f));

  const identity: FieldVerdict = !priced ? "n/a" : (l.identity ?? "match") === "match" ? "correct" : o.flags.some((f) => IDENTITY_FLAGS.has(f)) ? "correct" : "missing";
  // Total: a label of null means "no firm all-in total": correct only when none is stored or it carries a caveat.
  const total: FieldVerdict = !priced ? "n/a" : l.total_usd === null ? (o.total_usd === null || caveated ? "correct" : "wrong") : num(l.total_usd, o.total_usd);
  const tax: FieldVerdict = !priced || l.tax === "not_mentioned" ? "n/a" : o.tax === null || o.tax === "not_mentioned" ? "missing" : o.tax === l.tax ? "correct" : "wrong";
  const fees: FieldVerdict = !priced || !l.fees.length ? "n/a"
    : l.fees.every((f) => o.fees.some((g) => g.amount_usd !== null && close(g.amount_usd, f.amount_usd) && (g.included === null || g.included === f.included))) ? "correct"
    : o.fees.length === 0 ? "missing" : "wrong";
  const date: FieldVerdict = !priced ? "n/a" : bool(l.date_ok, o.date_ok);
  const veg = l.veg_count === null ? null : l.veg_count >= 12;
  const fields: Record<Field, FieldVerdict> = {
    identity, total, tax, fees,
    delivery: priced ? bool(l.delivery, o.delivery) : "n/a",
    date,
    deposit: priced ? num(l.deposit_usd, o.deposit_usd) : "n/a",
    req_veg: priced ? bool(veg, o.requirements.req_veg ?? null) : "n/a",
    req_delivery: priced ? bool(l.delivery, o.requirements.req_delivery ?? null) : "n/a",
  };

  const shown: string[] = [];
  if (o.shown_total_usd !== null) {
    const firmWrong = l.total_usd !== null && !close(o.shown_total_usd, l.total_usd);
    const unfirmShownFirm = l.total_usd === null && !caveated;
    const leaked = (l.leak_values_usd ?? []).some((x) => close(o.shown_total_usd!, x));
    if (firmWrong || unfirmShownFirm || leaked || !priced) shown.push("total");
  }
  if (o.shown_deposit_usd !== null && (l.deposit_usd === null ? o.shown_deposit_usd > 0 : !close(o.shown_deposit_usd, l.deposit_usd))) shown.push("deposit");
  return { id: c.id, fields, money_error_shown: shown, money_error_approvable: o.approvable ? shown : [] };
}

export interface FieldSummary {
  /** Per field: correct / missing / wrong over the cases where the label defines it (n/a excluded). */
  fields: Record<Field, { correct: number; missing: number; wrong: number; of: number }>;
  money_errors_shown: { cases: string[]; count: number };
  money_errors_approvable: { cases: string[]; count: number };
}

export function summarizeFields(scores: FieldScore[]): FieldSummary {
  const fields = Object.fromEntries(FIELDS.map((f) => {
    const vs = scores.map((s) => s.fields[f]).filter((v) => v !== "n/a");
    return [f, { correct: vs.filter((v) => v === "correct").length, missing: vs.filter((v) => v === "missing").length, wrong: vs.filter((v) => v === "wrong").length, of: vs.length }];
  })) as FieldSummary["fields"];
  const shown = scores.filter((s) => s.money_error_shown.length).map((s) => `${s.id} (${s.money_error_shown.join("+")})`);
  const appr = scores.filter((s) => s.money_error_approvable.length).map((s) => `${s.id} (${s.money_error_approvable.join("+")})`);
  return { fields, money_errors_shown: { cases: shown, count: shown.length }, money_errors_approvable: { cases: appr, count: appr.length } };
}
