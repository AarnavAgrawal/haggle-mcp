// PURE: does the business's money add up? Deterministic checks on a validated reading, in integer
// cents, run after the extractor (Claude or the keyword fallback) and before anything is stored.
//
// The extractor reads figures; it never does the arithmetic that makes a quote approvable. This file:
//   - de-duplicates a charge read twice (the delivery fee as both `delivery_fee` and an "other fee");
//   - reconciles a STATED total against the business's own parts (food, delivery, fees, discounts,
//     tax). A material difference is an issue that blocks approval until the business clarifies;
//     the stated total is never replaced with a computed one;
//   - places a charge whose relation to the total the reader left unclear (or got wrong) only when the
//     business's own figures settle it to the cent;
//   - turns "half up front" / "a 30% deposit" into an amount only when the total it applies to is clear,
//     and checks a stated deposit against a stated percentage.
// Unknown is never zero: a charge with no amount, or a tax with no amount or rate, can only explain a
// stated total that is HIGHER than the known parts (a minimum order, a folded-in fee), never one that is
// lower. Live eval 2026-10-23 (fx-08): "40 x $26 = $1,040, Delivery $80, Total $1,050" was approvable at $1,050.

/** A stated total "equals" its parts within this many cents (one rounding on a read-back or a rate). */
export const RECONCILE_TOLERANCE_CENTS = 100;
/** A tax hidden in a "tax included" total, as a share of its base: 0, or a real sales-tax rate. */
const TAX_SHARE_MIN = 0.02;
const TAX_SHARE_MAX = 0.15;
/** Above this many charges of unclear placement, nothing is placed (2^n hypotheses). */
const MAX_UNPLACED = 6;

export type FinancialIssueCode =
  /** The stated total doesn't equal the business's own parts (food, delivery, fees, tax), however they are placed. */
  | "total_mismatch"
  /** Per-unit price x quantity doesn't equal the stated subtotal. */
  | "line_items_mismatch"
  /** The deposit stated as an amount disagrees with the percentage or fraction stated for it. */
  | "deposit_mismatch"
  /** The deposit is larger than the total. */
  | "deposit_over_total"
  /** A deposit was mentioned ("half up front", "deposit required") but its amount can't be worked out. */
  | "deposit_unquantified"
  /** The attached quote's total and the total written in the email disagree. */
  | "document_total_mismatch"
  /** The amount due now (a custom payable field) is larger than the total. */
  | "payable_over_total";

export interface FinancialIssue {
  code: FinancialIssueCode;
  /** One line for the human and the agent, in the business's own figures. */
  detail: string;
  stated_cents?: number;
  expected_cents?: number;
}

/** What the integrity pass found, stored on the quote record. */
export interface FinancialCheck {
  /** The total exactly as the business stated it (before Haggle added tax or excluded fees); null if none was stated. */
  stated_total_cents: number | null;
  /** "consistent": the parts add up to the stated total; "unverifiable": too few parts to check; "inconsistent": see issues. */
  status: "consistent" | "unverifiable" | "inconsistent";
  issues: FinancialIssue[];
  /** What the pass changed, each labelled (e.g. "dropped duplicate fee 'Delivery fee' ($75.00): same as the delivery fee"). */
  notes: string[];
}

export const usd = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A fee or discount line as validated (cents; a discount is negative). */
export interface FeeLine { label: string; amount_cents: number | null; included_in_total: boolean | null; excerpt: string }

const DELIVERY_LABEL = /\bdeliver/i;
/** The business's words for its total put delivery in it ("$1,120 delivered", "including delivery"), and don't say it's extra. */
const DELIVERY_IN_TOTAL = /\bdelivered\b|\b(?:incl(?:uding|udes|\.)?|with)\s+(?:the\s+)?deliver(?:y|ing)\b|\bdeliver(?:y|ed)\s+(?:is\s+|are\s+)?included\b/i;
const DELIVERY_EXTRA = /\b(?:plus|extra|additional|on top|not included|excl(?:uding|udes|\.)?)\b|\+/i;
const TAX_LABEL = /\b(sales\s+)?tax\b/i;
/** A line that lowers the price ("10% nonprofit discount", "credit", "promo"). */
export const DISCOUNT_LABEL = /\b(discount|credit|promo|coupon|rebate|off)\b/i;

/**
 * Charges read twice are counted once: an "other fee" that is the delivery fee (labelled delivery, same
 * amount) or the stated tax (labelled tax, same amount), and repeated identical lines. Live eval
 * 2026-10-23 (c13, fx-11): "Delivery fee: $75" was both the delivery fee and an unclear fee.
 */
export function dedupeFees(fees: FeeLine[], deliveryCents: number | null, taxCents: number | null): { fees: FeeLine[]; notes: string[] } {
  const out: FeeLine[] = [];
  const notes: string[] = [];
  for (const f of fees) {
    const a = f.amount_cents;
    const same = a !== null && out.some((g) => g.amount_cents === a && g.label.trim().toLowerCase() === f.label.trim().toLowerCase());
    if (a !== null && a > 0 && deliveryCents !== null && a === deliveryCents && DELIVERY_LABEL.test(f.label)) notes.push(`dropped duplicate fee "${f.label}" (${usd(a)}): it is the delivery fee`);
    else if (a !== null && a > 0 && taxCents !== null && a === taxCents && TAX_LABEL.test(f.label)) notes.push(`dropped duplicate fee "${f.label}" (${usd(a)}): it is the tax`);
    else if (same) notes.push(`dropped repeated fee "${f.label}" (${usd(a!)})`);
    else out.push(f);
  }
  return { fees: out, notes };
}

/** How tax relates to the stated total, for the arithmetic. */
export type TaxPart =
  | { kind: "inside_amount"; cents: number } // a stated amount the total includes
  | { kind: "inside_rate"; rate_percent: number } // the total includes tax at this rate (on food, or food + delivery)
  | { kind: "inside_unknown" } // "tax included", no amount or rate: 0 (tax-inclusive prices) or a real rate
  | { kind: "outside" } // added on top of the stated total: not part of it
  | { kind: "unstated" }; // tax never mentioned: 0, or folded in silently (a real rate)

export interface ReconcileInput {
  stated_total_cents: number;
  /** Food: a stated subtotal, or a per-unit price x the quantity the business stated. Null = unknown. */
  food_cents: number | null;
  /** The delivery fee (null = no amount stated) and whether the reader said the total includes it. */
  delivery: { cents: number | null; included: boolean | null };
  tax: TaxPart;
  fees: FeeLine[];
  /** The business's words for the total ("Total: $1,120 delivered"): saying delivery there places the fee inside. */
  total_excerpt?: string;
}

export interface Reconciliation {
  verdict: "consistent" | "inconsistent" | "unverifiable" | "ambiguous";
  /** Where each unclear charge goes, when the figures settle it. */
  delivery?: "inside" | "outside";
  fees: ("inside" | "outside" | null)[];
  /** Cents the all-in total adds on top of the stated total (charges placed outside it). */
  outside_cents: number;
  /** For an inconsistent total: what the parts add up to with every listed charge inside it. */
  expected_cents?: number;
}

interface Item { kind: "delivery" | "fee"; index: number; cents: number; options: ("inside" | "outside")[] }

/**
 * Every reading of the unclear charges (each inside or outside the stated total) that makes the parts add
 * up, preferring one that adds up to the cent. One answer (or several with the same all-in total) settles
 * it; none is an inconsistent total; several different all-in totals are ambiguous (never guessed).
 */
export function reconcileTotal(i: ReconcileInput): Reconciliation {
  const T = i.stated_total_cents;
  const tol = RECONCILE_TOLERANCE_CENTS;
  const items: Item[] = [];
  let anyUnknownInside = i.food_cents === null;
  const d = i.delivery;
  const deliveryWords = DELIVERY_IN_TOTAL.test(i.total_excerpt ?? "") && !DELIVERY_EXTRA.test(i.total_excerpt ?? "");
  if (d.cents !== null && d.cents > 0) {
    // The reader's delivery_included is unreliable (eval c40: "false" for a fee its own total included);
    // only a business that said so ("delivery included", "$1,120 delivered") fixes it inside.
    items.push({ kind: "delivery", index: -1, cents: d.cents, options: d.included === true || deliveryWords ? ["inside"] : ["inside", "outside"] });
  } else if (d.cents === null && d.included === true) anyUnknownInside = true; // included at a price folded into the others
  i.fees.forEach((f, index) => {
    if (f.amount_cents === null) {
      if (f.included_in_total !== false) anyUnknownInside = true;
      return;
    }
    if (f.amount_cents === 0) return;
    // The reader's yes/no on a fee is kept (eval: c14, c39, c40 right); only an unclear one is placed.
    const options: Item["options"] = f.included_in_total === true ? ["inside"] : f.included_in_total === false ? ["outside"] : ["inside", "outside"];
    items.push({ kind: "fee", index, cents: f.amount_cents, options });
  });
  const unplaced = items.filter((x) => x.options.length > 1).length;
  if (unplaced > MAX_UNPLACED) return { verdict: "unverifiable", fees: i.fees.map(() => null), outside_cents: 0 };

  type Hyp = { place: ("inside" | "outside")[]; residual: number; exact: boolean; outside: number; known: number };
  const fits: Hyp[] = [];
  // The natural reading of an itemised reply: every listed charge is inside the total (unless the reader
  // said a fee is extra). An inconsistent total is reported against it.
  let natural: Hyp | null = null;
  const combos = items.reduce<("inside" | "outside")[][]>((acc, it) => acc.flatMap((p) => it.options.map((o) => [...p, o])), [[]]);
  for (const place of combos) {
    let inside = i.food_cents ?? 0;
    let outside = 0;
    let deliveryInside = 0;
    items.forEach((it, k) => {
      if (place[k] === "inside") { inside += it.cents; if (it.kind === "delivery") deliveryInside = it.cents; }
      else outside += it.cents;
    });
    const fit = taxFit(T - inside, i, inside, i.food_cents, deliveryInside, anyUnknownInside, tol);
    const h: Hyp = { place, residual: fit.residual, exact: fit.exact, outside, known: inside + fit.taxCents };
    if (!natural) natural = h; // options list "inside" first
    if (fit.ok) fits.push(h);
  }
  const fees = (h: Hyp | null) => i.fees.map((_, index) => { const k = items.findIndex((x) => x.kind === "fee" && x.index === index); return k >= 0 && h ? h.place[k]! : null; });
  const delivery = (h: Hyp) => { const k = items.findIndex((x) => x.kind === "delivery"); return k >= 0 ? h.place[k] : undefined; };
  if (!fits.length) return { verdict: "inconsistent", fees: fees(null), outside_cents: 0, expected_cents: natural!.known };
  // Only figures that add up to the cent move a charge outside the stated total. A looser fit (a tax or
  // charge of unknown size absorbing the difference) may confirm the natural reading, never place money
  // on top of the business's total: any other loose fit leaves the all-in total unknown (Haggle asks).
  const exact = fits.filter((h) => h.exact);
  // A loose fit with a charge still unplaced (food unknown, or a tax of unknown size) fits either way.
  const pool = exact.length ? exact : unplaced === 0 ? fits : [];
  if (!pool.length || new Set(pool.map((h) => h.outside)).size > 1) return { verdict: "ambiguous", fees: fees(null), outside_cents: 0 };
  const h = pool[0]!;
  const where = delivery(h);
  // Nothing to compare against (food unknown, nothing placed): the total can't be checked, only bounded.
  const verdict = i.food_cents === null && !exact.length ? "unverifiable" : "consistent";
  return { verdict, ...(where ? { delivery: where } : {}), fees: fees(h), outside_cents: h.outside };
}

/**
 * Does `residual` (stated total - known parts inside it) fit what is still unknown inside the total?
 * A charge of unknown amount fits any non-negative residual; tax alone fits 0 (tax-inclusive prices) or a
 * real rate on its base; a stated rate fits that rate on food or food + delivery; nothing unknown fits 0.
 */
function taxFit(residual: number, i: ReconcileInput, inside: number, food: number | null, deliveryInside: number, anyUnknown: boolean, tol: number): { ok: boolean; exact: boolean; residual: number; taxCents: number } {
  const t = i.tax;
  if (t.kind === "inside_amount") {
    const r = residual - t.cents;
    return { ok: anyUnknown ? r >= -tol : Math.abs(r) <= tol, exact: Math.abs(r) <= tol, residual: r, taxCents: t.cents };
  }
  if (t.kind === "inside_rate" && food !== null) {
    const bases = [food, ...(deliveryInside ? [food + deliveryInside] : [])];
    const best = bases.map((b) => Math.round((b * t.rate_percent) / 100)).map((tax) => ({ tax, r: residual - tax })).sort((a, b) => Math.abs(a.r) - Math.abs(b.r))[0]!;
    return { ok: anyUnknown ? best.r >= -tol : Math.abs(best.r) <= tol, exact: Math.abs(best.r) <= tol, residual: best.r, taxCents: best.tax };
  }
  const exact = Math.abs(residual) <= tol;
  if (anyUnknown) return { ok: residual >= -tol, exact, residual, taxCents: 0 };
  if (t.kind === "outside") return { ok: exact, exact, residual, taxCents: 0 };
  // "tax included" (no figure) or never mentioned: 0, or a plausible sales-tax share of the base.
  const plausible = residual >= Math.floor(inside * TAX_SHARE_MIN) - tol && residual <= Math.ceil(inside * TAX_SHARE_MAX) + tol;
  return { ok: exact || plausible, exact, residual, taxCents: plausible && !exact ? residual : 0 };
}

// ───────────────────────────── deposits ─────────────────────────────

/** A deposit stated as a share of the total, as an exact fraction. */
export interface DepositShare { num: number; den: number; phrase: string }

/** A share in words right next to what it pays for ("half up front", "a third to hold the date", "deposit of half"). */
const DUE_NOW = String.raw`(?:of the (?:total|amount|order|bill)\s+)?(?:is\s+|will be\s+)?(?:due\s+|payable\s+|paid\s+)?(?:up\s*-?\s*front|upfront|now|down|as (?:a |the )?deposit|deposit|at booking|on booking|upon booking|to (?:book|hold|reserve|secure|confirm))`;
const WORD_SHARES: [RegExp, number, number][] = (
  [["(?:one |a )?half", 1, 2], ["(?:one |a )third", 1, 3], ["two[- ]thirds", 2, 3], ["(?:one |a )quarter", 1, 4]] as const
).map(([w, num, den]) => [new RegExp(String.raw`\b${w}\s+${DUE_NOW}\b|\bdeposit\s*(?:of|is|:)?\s*${w}\b`, "i"), num, den]);
WORD_SHARES.push([/\b50\s*\/\s*50\b/i, 1, 2]);
/** Where a share is about the deposit (not "half the menu is vegetarian"). */
const DEPOSIT_CONTEXT = /\b(deposit|retainer|down(?:\s*payment)?|up\s*-?\s*front|upfront|at booking|on booking|to (?:book|hold|reserve|secure)|due (?:at|on|upon) (?:booking|signing|confirmation)|now,? (?:and )?(?:the )?(?:rest|balance))\b/i;
const NO_DEPOSIT = /\bno (?:deposit|retainer|down\s*payment)\b|\bdeposit(?:\s+is)?\s+not\s+(?:required|needed)\b|\bwithout (?:a |any )?deposit\b|\bno (?:money|payment) (?:up\s*-?\s*front|upfront|in advance)\b/i;
const DEPOSIT_WORD = /\b(deposit|retainer|down\s*payment|prepayment)\b/i;

/**
 * The deposit share the business stated ("half up front", "50% deposit due at booking", "a third to hold
 * the date"), from the sentences that talk about the deposit. "none" = the business said no deposit;
 * "mentioned" = a deposit is mentioned with no amount or share; null = nothing said. Two different
 * shares are not guessed between ("mentioned").
 */
export function depositShare(texts: readonly string[]): DepositShare | "none" | "mentioned" | null {
  const sentences = texts.flatMap((t) => t.split(/(?<=[.!?;\n])\s+|\n+/)).map((s) => s.trim()).filter(Boolean);
  const found: DepositShare[] = [];
  let mentioned = false;
  let none = false;
  for (const s of sentences) {
    if (NO_DEPOSIT.test(s)) { none = true; continue; }
    if (!DEPOSIT_CONTEXT.test(s) && !DEPOSIT_WORD.test(s)) continue;
    mentioned ||= DEPOSIT_WORD.test(s) || /\bup\s*-?\s*front|upfront\b/i.test(s);
    // "25% non-refundable deposit", "deposit of 30%", "50% due at booking" (never "8.5% tax" or "18% service").
    for (const m of s.matchAll(/(\d{1,3}(?:\.\d{1,2})?)\s*(?:%|percent\b)/gi)) {
      const after = s.slice(m.index! + m[0].length, m.index! + m[0].length + 40);
      const before = s.slice(Math.max(0, m.index! - 30), m.index!);
      if (/^\s*(?:sales\s+)?(?:tax|service|gratuity|tip|surcharge|discount|off)\b/i.test(after)) continue;
      if (!DEPOSIT_CONTEXT.test(after) && !DEPOSIT_CONTEXT.test(before)) continue;
      const pct = Number(m[1]);
      if (!(pct > 0 && pct <= 100)) continue;
      const scaled = Math.round(pct * 100); // basis points: exact for up to 2 decimals
      found.push({ num: scaled, den: 10_000, phrase: m[0] });
    }
    for (const [re, num, den] of WORD_SHARES) {
      const m = s.match(re);
      if (m) found.push({ num, den, phrase: m[0].trim() });
    }
  }
  const distinct = [...new Map(found.map((f) => [f.num / f.den, f])).values()];
  if (distinct.length === 1) return distinct[0]!;
  if (distinct.length > 1) return "mentioned";
  if (mentioned) return "mentioned";
  return none ? "none" : null;
}

/** share x total in whole cents (half-up). */
export function shareOf(totalCents: number, s: DepositShare): number {
  return Math.floor((totalCents * s.num * 2 + s.den) / (2 * s.den));
}

export interface DepositInput {
  deposit_cents: number | null;
  /** The all-in total Haggle stores, and the total the business stated (null: Haggle worked it out). */
  total_cents: number | null;
  stated_total_cents: number | null;
  share: DepositShare | "none" | "mentioned" | null;
}

/**
 * A deposit from a stated share, only when the total it applies to is the business's own all-in total
 * (with fees or tax Haggle added on top, "half" of which figure is unclear). A stated amount is checked
 * against a stated share (of the stated or the all-in total). Never replaces a stated amount.
 */
export function checkDeposit(i: DepositInput): { deposit_cents: number | null; computed?: string; issue?: FinancialIssue } {
  const { deposit_cents: dep, total_cents: total, stated_total_cents: stated, share } = i;
  if (dep !== null && total !== null && dep > total) return { deposit_cents: dep, issue: { code: "deposit_over_total", detail: `the deposit (${usd(dep)}) is more than the total (${usd(total)})`, stated_cents: dep, expected_cents: total } };
  if (share === null || share === "none") return { deposit_cents: dep };
  if (dep !== null) {
    if (share === "mentioned") return { deposit_cents: dep };
    const bases = [...new Set([total, stated].filter((x): x is number => x !== null))];
    if (!bases.length || bases.some((b) => Math.abs(shareOf(b, share) - dep) <= RECONCILE_TOLERANCE_CENTS)) return { deposit_cents: dep };
    const expected = shareOf(bases[0]!, share);
    return { deposit_cents: dep, issue: { code: "deposit_mismatch", detail: `the deposit is stated as ${usd(dep)} but also as ${share.phrase} (${usd(expected)} of ${usd(bases[0]!)})`, stated_cents: dep, expected_cents: expected } };
  }
  if (share === "mentioned") return { deposit_cents: null, issue: { code: "deposit_unquantified", detail: "a deposit is mentioned but its amount isn't stated" } };
  if (total === null || stated === null || total !== stated) {
    return { deposit_cents: null, issue: { code: "deposit_unquantified", detail: `the deposit is ${share.phrase} of the total, but which total isn't clear${total !== null ? ` (Haggle's all-in total is ${usd(total)})` : ""}` } };
  }
  return { deposit_cents: shareOf(total, share), computed: `computed: ${share.phrase} of the stated total ${usd(total)}` };
}

// ───────────────────────────── on the stored record ─────────────────────────────

/** The issues that hold a quote back (empty = its figures are consistent or can't be checked). */
export function financialIssues(r: { financial?: FinancialCheck }): FinancialIssue[] {
  return r.financial?.issues ?? [];
}

/** One line for the approval block and the follow-up to the business. */
export function issuesText(issues: readonly FinancialIssue[]): string {
  return issues.map((x) => x.detail).join("; ");
}

/** Issues about the deposit: settled by the business stating a deposit, unlike a total that doesn't add up. */
export const DEPOSIT_ISSUES: ReadonlySet<FinancialIssueCode> = new Set(["deposit_unquantified", "deposit_mismatch", "deposit_over_total"]);

/**
 * A record stored before this check existed (no `financial`): its stated total is re-checked from the
 * stored parts at approval time, so a quote read before the integrity pass can't be approved on figures
 * that don't add up. A total Haggle worked out itself (source "computed …") has nothing stated to check.
 */
export function recordIssues(r: import("./extraction.ts").QuoteRecord): FinancialIssue[] {
  if (r.financial) return r.financial.issues;
  if (!r.available || r.total_cents === null || /^computed/.test(r.sources.total?.source ?? "")) return [];
  const food = r.subtotal_cents ?? (r.price_per_head_cents !== null && r.headcount !== null && r.headcount > 0 ? r.price_per_head_cents * r.headcount : null);
  if (food === null) return [];
  const status = r.tax?.status ?? (r.tax_included === true ? "included" : r.tax_included === false ? "added_on_top" : "not_mentioned");
  const tax: TaxPart = status === "added_on_top" ? { kind: "outside" } : r.tax_cents !== null ? { kind: "inside_amount", cents: r.tax_cents }
    : status === "included" ? (r.tax?.rate_percent != null ? { kind: "inside_rate", rate_percent: r.tax.rate_percent } : { kind: "inside_unknown" }) : { kind: "unstated" };
  const rec = reconcileTotal({ stated_total_cents: r.total_cents, food_cents: food, delivery: { cents: r.delivery_fee_cents, included: r.delivery_included }, tax, fees: r.other_fees ?? [], total_excerpt: r.sources.total?.excerpt ?? "" });
  return rec.verdict === "inconsistent" ? [{ code: "total_mismatch", detail: `the listed charges add up to ${usd(rec.expected_cents!)}, but the stated total is ${usd(r.total_cents)}`, stated_cents: r.total_cents, expected_cents: rec.expected_cents! }] : [];
}
