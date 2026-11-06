// The admin pages' logic (lib/dashboard/ledger.ts): grouping, the quote spread, totals, attention,
// filters and sorting, the history timeline and CSV export. Pure; no server.
import { describe, expect, it } from "vitest";
import {
  attention, byDay, csvCell, dayLabel, dealViews, filterDeals, filterHistory, filterQuotes, historyRows, leadQuote, ledgerGroup, ledgerStatus, pipeline, pricedQuotes, quoteRows, quoteSpread, quoteViews,
  DEAL_CHOICES, DEAL_DEFAULTS, HISTORY_CHOICES, HISTORY_DEFAULTS, QUOTE_CHOICES, QUOTE_DEFAULTS, boardFigures, compareMatrix, quoteWarning, readQuery, savedOn, sortDeals, sortQuotes, stageOf, toCsv, totals,
  type LedgerDeal, type LedgerQuote,
} from "../lib/dashboard/ledger.ts";
import type { DealBoardView } from "../lib/dashboard/types.ts";

const money = (n: number) => `$${n}`;
const quote = (id: string, total: number | null, extra: Partial<LedgerQuote> = {}): LedgerQuote => ({
  quote_id: id, business_id: `b_${id}`, business: `Biz ${id}`, channel: "email", round: 1, status: "current", total_usd: total, meets_requirements: true, flags: [], items: [], confidence: 0.9, source: "email body",
  received_at: "2026-11-05T10:00:00Z", ...extra,
});
const deal = (id: string, extra: Partial<LedgerDeal> = {}): LedgerDeal => ({
  job_id: id, what: `Deal ${id}`, state: "collecting", ready: false, created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-02T10:00:00Z", budget_usd: null, limit_usd: null, recommended_quote_id: null,
  businesses: [], quotes: [], questions: [], approval: null, payment: null, events: [], ...extra,
});
const question = (id: string, at: string) => ({ question_id: id, business_id: "b", business: "Biz", text: "How many plates?", asked_at: at });
const approval = (quoteId: string, status: string, total: number) => ({ quote_id: quoteId, business_id: "b", status, amount_usd: 5, total_usd: total, channel: "web", decided_at: "2026-11-03T00:00:00Z" });

describe("ledgerGroup and ledgerStatus", () => {
  it("counts an open deal with a business's question as needing the buyer, whatever its state", () => {
    expect(ledgerGroup(deal("a", { state: "collecting", questions: [question("q1", "2026-11-01T00:00:00Z")] }))).toBe("needs_you");
    expect(ledgerGroup(deal("b", { state: "collecting" }))).toBe("in_progress");
    expect(ledgerGroup(deal("c", { state: "awaiting_approval" }))).toBe("needs_you");
  });

  it("ignores a leftover question once the deal has ended", () => {
    const d = deal("a", { state: "cancelled", questions: [question("q1", "2026-11-01T00:00:00Z")] });
    expect(ledgerGroup(d)).toBe("done");
    expect(ledgerStatus(d)).toEqual({ tone: "idle", words: "Cancelled" });
  });

  it("says who is waiting on whom, counting businesses rather than quote versions", () => {
    expect(ledgerStatus(deal("a", { questions: [question("q1", "x")] }))).toEqual({ tone: "hold", words: "A business asked you something" });
    expect(ledgerStatus(deal("a", { questions: [question("q1", "x"), question("q2", "y")] })).words).toBe("2 questions for you");
    const businesses = [{ id: "b_1", name: "One", channel: "email", status: "quoted" }, { id: "b_2", name: "Two", channel: "email", status: "contacted" }];
    expect(ledgerStatus(deal("a", { businesses, quotes: [quote("1", 100), quote("1b", 90, { business_id: "b_1" })] })).words).toBe("1 of 2 quoted");
    expect(ledgerStatus(deal("a", { state: "paying", purchase: { stage: "awaiting_vendor_confirmation" } })).words).toBe("Awaiting vendor confirmation");
    expect(ledgerStatus(deal("a", { state: "paying", purchase: { stage: "paying" } })).words).toBe("Approved, finish the purchase");
    expect(ledgerStatus(deal("a", { state: "paying" })).words).toBe("Approved, finish the purchase");
  });
});

describe("leadQuote and savedOn", () => {
  const quotes = [quote("cheap", 900), quote("rec", 1000, { negotiated_from: 1200 }), quote("picked", 1100, { negotiated_from: 1150 }), quote("old", 800, { status: "superseded" })];

  it("prefers the approved quote, then the recommendation, then the lowest current total", () => {
    expect(leadQuote(deal("a", { quotes, recommended_quote_id: "rec", approval: approval("picked", "approved", 1100) }))?.quote_id).toBe("picked");
    expect(leadQuote(deal("a", { quotes, recommended_quote_id: "rec", approval: approval("picked", "pending", 1100) }))?.quote_id).toBe("rec");
    expect(leadQuote(deal("a", { quotes }))?.quote_id).toBe("cheap");
    expect(leadQuote(deal("a"))).toBeNull();
  });

  it("never lets a suspicious or non-compliant quote become the lead just by being cheapest", () => {
    const scam = quote("scam", 100, { flags: ["prompt_injection"] });
    const link = quote("link", 150, { flags: ["external_payment_link"] });
    const short = quote("short", 200, { meets_requirements: false });
    expect(leadQuote(deal("a", { quotes: [scam, link, short, quote("real", 900)] }))?.quote_id).toBe("real");
    expect(leadQuote(deal("a", { quotes: [scam, link] }))).toBeNull();
    // Over budget is a caution, not an alarm: it can still lead.
    expect(leadQuote(deal("a", { quotes: [quote("over", 900, { flags: ["over_budget"] })] }))?.quote_id).toBe("over");
  });

  it("has no lead on a stopped deal, and no savings to claim from it", () => {
    const d = deal("a", { state: "cancelled", quotes: [quote("x", 500, { negotiated_from: 900 })], recommended_quote_id: "x", approval: approval("x", "approved", 500) });
    expect(leadQuote(d)).toBeNull();
    expect(savedOn(d)).toBe(0);
  });

  it("never treats an unknown total as the lowest", () => {
    expect(leadQuote(deal("a", { quotes: [quote("none", null), quote("real", 500)] }))?.quote_id).toBe("real");
    expect(pricedQuotes(deal("a", { quotes: [quote("none", null)] }))).toEqual([]);
  });

  it("counts savings only from a real earlier price on the lead quote", () => {
    expect(savedOn(deal("a", { quotes, recommended_quote_id: "rec" }))).toBe(200);
    expect(savedOn(deal("a", { quotes: [quote("x", 500)] }))).toBe(0);
    expect(savedOn(deal("a", { quotes: [quote("x", 500, { negotiated_from: 400 })] }))).toBe(0);
  });
});

describe("quoteSpread", () => {
  it("is null without a priced quote", () => {
    expect(quoteSpread(deal("a", { quotes: [quote("x", null)] }), money)).toBeNull();
  });

  it("scales from the lowest to the highest value, the budget included", () => {
    const s = quoteSpread(deal("a", { budget_usd: 1500, quotes: [quote("x", 1000), quote("y", 1200)], recommended_quote_id: "y" }), money)!;
    expect(s.marks.map((m) => m.at)).toEqual([0, 0.4]);
    expect(s.budgetAt).toBe(1);
    expect(s.marks.find((m) => m.picked)?.quote_id).toBe("y");
    expect(s.words).toBe("2 quotes from $1000 to $1200, budget $1500");
  });

  it("circles only a quote someone chose: the pen never marks the merely cheapest, or a stopped deal", () => {
    expect(quoteSpread(deal("a", { quotes: [quote("x", 1000), quote("y", 1200)] }), money)!.marks.some((m) => m.picked)).toBe(false);
    expect(quoteSpread(deal("a", { state: "cancelled", quotes: [quote("x", 1000)], recommended_quote_id: "x" }), money)!.marks.some((m) => m.picked)).toBe(false);
    const approved = quoteSpread(deal("a", { quotes: [quote("x", 1000), quote("y", 1200)], recommended_quote_id: "x", approval: approval("y", "approved", 1200) }), money)!;
    expect(approved.marks.filter((m) => m.picked).map((m) => m.quote_id)).toEqual(["y"]);
  });

  it("centers a lone value instead of dividing by zero, and leaves out replaced versions", () => {
    const s = quoteSpread(deal("a", { quotes: [quote("x", 1000), quote("old", 5000, { status: "superseded" })] }), money)!;
    expect(s.marks).toHaveLength(1);
    expect(s.marks[0]!.at).toBe(0.5);
    expect(s.budgetAt).toBeNull();
    expect(s.words).toBe("1 quote at $1000");
  });
});

describe("totals and pipeline", () => {
  const deals = [
    deal("a", { state: "awaiting_approval", quotes: [quote("1", 100), quote("2", null)] }),
    deal("b", { state: "negotiating", quotes: [quote("3", 200, { negotiated_from: 260 })], recommended_quote_id: "3" }),
    deal("c", { state: "paid", quotes: [quote("4", 300, { negotiated_from: 310 })], approval: approval("4", "used", 300) }),
    deal("d", { state: "cancelled", quotes: [quote("5", 400, { negotiated_from: 900 })], approval: approval("5", "approved", 400), recommended_quote_id: "5" }),
  ];

  it("adds up what is true: priced quotes on open deals, and nothing from a stopped deal's money", () => {
    expect(totals(deals)).toEqual({ needsYou: 1, inProgress: 1, done: 2, quotes: 2, approvedUsd: 300, savedUsd: 70 });
    expect(totals([])).toEqual({ needsYou: 0, inProgress: 0, done: 0, quotes: 0, approvedUsd: 0, savedUsd: 0 });
  });

  it("keeps every stage, in order, with its count", () => {
    const p = pipeline(deals);
    expect(p.map((s) => s.key)).toEqual(["contacting", "collecting", "negotiating", "approval", "paying", "finished", "stopped"]);
    expect(p.find((s) => s.key === "stopped")?.count).toBe(1);
    expect(p.find((s) => s.key === "contacting")?.count).toBe(0);
    expect(stageOf("created")).toBe("contacting");
    expect(stageOf("confirmed")).toBe("finished");
  });
});

describe("attention", () => {
  it("lists questions oldest first, then approvals, then purchases, and skips finished deals", () => {
    const items = attention([
      deal("pay", { state: "paying" }),
      deal("ok", { state: "awaiting_approval", quotes: [quote("1", 100)] }),
      deal("q", { questions: [question("late", "2026-11-03T00:00:00Z"), question("early", "2026-11-01T00:00:00Z")] }),
      deal("gone", { state: "cancelled", questions: [question("x", "2026-10-01T00:00:00Z")] }),
    ]);
    expect(items.map((i) => i.id)).toEqual(["early", "late", "approve-ok", "purchase-pay"]);
    const approve = items[2]!;
    expect(approve.kind === "approve" && approve.quote?.quote_id).toBe("1");
  });

  it("names the quote a pending approval is really for, even if a better one arrived since", () => {
    const d = deal("a", { state: "awaiting_approval", quotes: [quote("asked", 900), quote("better", 800)], recommended_quote_id: "better", approval: approval("asked", "pending", 900) });
    const item = attention([d])[0]!;
    expect(item.kind === "approve" && item.quote?.quote_id).toBe("asked");
  });
});

describe("deal filters and sorting", () => {
  const a = deal("a", { what: "Team dinner", area: "Mission", state: "paid", businesses: [{ id: "b", name: "Golden Grill", channel: "email", status: "won" }], quotes: [quote("1", 300)], updated_at: "2026-11-03T00:00:00Z" });
  const b = deal("b", { what: "Breakfast", state: "collecting", quotes: [quote("2", 100), quote("3", 150)], updated_at: "2026-11-04T00:00:00Z" });
  const c = deal("c", { what: "Almonds", state: "awaiting_approval", updated_at: "2026-11-01T00:00:00Z" });

  it("filters by view, stage and a search across the request, place and businesses", () => {
    expect(filterDeals([a, b, c], { view: "done" }).map((d) => d.job_id)).toEqual(["a"]);
    expect(filterDeals([a, b, c], { view: "all", stage: "collecting" }).map((d) => d.job_id)).toEqual(["b"]);
    expect(filterDeals([a, b, c], { q: "golden" }).map((d) => d.job_id)).toEqual(["a"]);
    expect(filterDeals([a, b, c], { q: "  MISSION " }).map((d) => d.job_id)).toEqual(["a"]);
    expect(filterDeals([a, b, c], {})).toHaveLength(3);
  });

  it("counts each view", () => {
    expect(dealViews([a, b, c]).map((v) => [v.key, v.count])).toEqual([["all", 3], ["needs_you", 1], ["in_progress", 1], ["done", 1]]);
  });

  it("sorts either way and keeps a deal with no price last in both", () => {
    expect(sortDeals([a, b, c], "best", "asc").map((d) => d.job_id)).toEqual(["b", "a", "c"]);
    expect(sortDeals([a, b, c], "best", "desc").map((d) => d.job_id)).toEqual(["a", "b", "c"]);
    expect(sortDeals([a, b, c], "what", "asc").map((d) => d.job_id)).toEqual(["c", "b", "a"]);
    expect(sortDeals([a, b, c], "updated", "desc").map((d) => d.job_id)).toEqual(["b", "a", "c"]);
    expect(sortDeals([a, b, c], "quotes", "desc").map((d) => d.job_id)).toEqual(["b", "a", "c"]);
  });

  it("doesn't reorder the rows it was given", () => {
    const rows = [a, b, c];
    sortDeals(rows, "what", "asc");
    expect(rows.map((d) => d.job_id)).toEqual(["a", "b", "c"]);
  });
});

describe("quote rows", () => {
  const deals = [
    deal("a", { what: "Lunch", recommended_quote_id: "rec", quotes: [quote("rec", 100, { received_at: "2026-11-02T00:00:00Z" }), quote("other", 200, { received_at: "2026-11-03T00:00:00Z", channel: "phone" }), quote("old", 300, { status: "superseded", received_at: "2026-11-01T00:00:00Z" })] }),
    deal("b", { what: "Dinner", state: "paid", approval: approval("won", "used", 400), quotes: [quote("won", 400, { received_at: "2026-11-04T00:00:00Z" })] }),
    deal("c", { what: "Stopped", state: "cancelled", recommended_quote_id: "dead", quotes: [quote("dead", 500, { received_at: "2026-11-05T00:00:00Z" })] }),
  ];
  const rows = quoteRows(deals);

  it("flattens every quote, newest first, with its standing", () => {
    expect(rows.map((r) => [r.quote_id, r.standing])).toEqual([["dead", "closed"], ["won", "approved"], ["other", "open"], ["rec", "recommended"], ["old", "replaced"]]);
    expect(rows[1]!.deal).toBe("Dinner");
  });

  it("filters by view, channel, deal and search", () => {
    expect(filterQuotes(rows, { view: "picks" }).map((r) => r.quote_id)).toEqual(["won", "rec"]);
    expect(filterQuotes(rows, { view: "replaced" }).map((r) => r.quote_id)).toEqual(["old"]);
    expect(filterQuotes(rows, { view: "current", channel: "phone" }).map((r) => r.quote_id)).toEqual(["other"]);
    expect(filterQuotes(rows, { deal: "b" }).map((r) => r.quote_id)).toEqual(["won"]);
    expect(filterQuotes(rows, { q: "dinner" }).map((r) => r.quote_id)).toEqual(["won"]);
    expect(filterQuotes(rows, { view: "current" }).map((r) => r.quote_id)).toEqual(["won", "other", "rec"]);
    expect(quoteViews(rows).map((v) => v.count)).toEqual([3, 2, 1, 5]);
  });

  it("names what to check, keeping red for an alarm and saying nothing once a quote is out of play", () => {
    expect(quoteWarning({ flags: ["prompt_injection"], standing: "open" })).toEqual({ tone: "risk", words: "Suspicious instructions" });
    expect(quoteWarning({ flags: ["over_budget", "external_payment_link"], standing: "recommended" })).toEqual({ tone: "risk", words: "Asked to pay at a link" });
    expect(quoteWarning({ flags: ["over_budget"], standing: "open" })).toEqual({ tone: "hold", words: "Over budget" });
    expect(quoteWarning({ flags: ["approximate_total"], standing: "open" })).toBeNull();
    expect(quoteWarning({ flags: ["prompt_injection"], standing: "closed" })).toBeNull();
    expect(quoteWarning({ flags: ["prompt_injection"], standing: "replaced" })).toBeNull();
  });

  it("sorts unknown totals last", () => {
    const withNone = [...rows, { ...rows[0]!, quote_id: "none", total_usd: null }];
    expect(sortQuotes(withNone, "total", "asc").at(-1)?.quote_id).toBe("none");
    expect(sortQuotes(withNone, "total", "desc").at(-1)?.quote_id).toBe("none");
    expect(sortQuotes(rows, "total", "desc")[0]?.quote_id).toBe("dead");
  });
});

describe("history", () => {
  const event = (seq: number, at: string, group: "quote" | "payment", text: string) => ({ seq, at, group, text });
  const deals = [
    deal("a", { what: "Lunch", events: [event(2, "2026-11-05T09:00:00Z", "quote", "Golden Grill quoted $1,380"), event(1, "2026-11-04T09:00:00Z", "payment", "Paid $5")] }),
    deal("b", { what: "Dinner", events: [event(1, "2026-11-05T10:00:00Z", "quote", "Bay Catering quoted $900")] }),
  ];
  const rows = historyRows(deals);

  it("drops the arrival line when that message was the business's quote, and keeps every other contact", () => {
    const at = "2026-11-05T09:00:00Z";
    const events = [
      { seq: 4, at, group: "quote" as const, business_id: "b1", business: "Golden Grill", text: "Golden Grill quoted $860" },
      { seq: 3, at, group: "contact" as const, business_id: "b1", business: "Golden Grill", text: "Email from Golden Grill" },
      { seq: 2, at, group: "contact" as const, business_id: "b2", business: "Harbor Table", text: "Email from Harbor Table" },
      { seq: 1, at, group: "contact" as const, business_id: "b1", business: "Golden Grill", text: "Golden Grill asked you a question" },
    ];
    expect(historyRows([deal("a", { events })]).map((r) => r.seq)).toEqual([4, 2, 1]);
  });

  it("puts every deal on one timeline, newest first, each event with a unique key", () => {
    expect(rows.map((r) => r.text)).toEqual(["Bay Catering quoted $900", "Golden Grill quoted $1,380", "Paid $5"]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
  });

  it("filters by kind, deal and search", () => {
    expect(filterHistory(rows, { group: "payment" })).toHaveLength(1);
    expect(filterHistory(rows, { deal: "b" })).toHaveLength(1);
    expect(filterHistory(rows, { q: "golden" })).toHaveLength(1);
    expect(filterHistory(rows, { q: "lunch" })).toHaveLength(2);
  });

  it("groups by day with plain labels", () => {
    const now = new Date("2026-11-05T20:00:00Z");
    expect(byDay(rows, now).map((g) => [g.label, g.items.length])).toEqual([["Today", 2], ["Yesterday", 1]]);
    expect(dayLabel("2026-11-02T09:00:00Z", now)).toBe("Mon, Nov 2");
  });
});

describe("CSV export", () => {
  it("defuses a business name a spreadsheet would run as a formula", () => {
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell("+1 415")).toBe("'+1 415");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell("@cmd")).toBe("'@cmd");
  });

  it("quotes separators, keeps real numbers as numbers and unknowns empty", () => {
    expect(csvCell("Bay, Catering")).toBe(`"Bay, Catering"`);
    expect(csvCell('Say "hi"')).toBe(`"Say ""hi"""`);
    expect(csvCell(-140)).toBe("-140");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("writes a header and one line per row", () => {
    expect(toCsv([{ a: "x", b: 1 }], [{ label: "A", value: (r) => r.a }, { label: "B", value: (r) => r.b }])).toBe("A,B\r\nx,1\r\n");
  });
});

describe("readQuery", () => {
  it("keeps allowed values, drops unknown keys and falls back on anything off the list", () => {
    expect(readQuery({ view: "done", sort: "best", dir: "asc", q: "lunch", evil: "x" }, DEAL_DEFAULTS, DEAL_CHOICES)).toEqual({ view: "done", stage: "", q: "lunch", sort: "best", dir: "asc" });
    expect(readQuery({ view: "<script>", dir: "sideways", stage: "nope" }, DEAL_DEFAULTS, DEAL_CHOICES)).toEqual(DEAL_DEFAULTS);
    expect(readQuery({ view: ["a", "b"] }, QUOTE_DEFAULTS, QUOTE_CHOICES)).toEqual(QUOTE_DEFAULTS);
    expect(readQuery({ q: "x".repeat(500) }, HISTORY_DEFAULTS, HISTORY_CHOICES).q).toHaveLength(120);
  });
});

describe("one deal's board", () => {
  const q = (id: string, total: number | null, extra: Record<string, unknown> = {}) => ({ ...quote(id, null), total_usd: total, ...extra }) as unknown as DealBoardView["quotes"][number];
  const board = (extra: Partial<DealBoardView> = {}) =>
    ({ job: { requirements: [], budget_usd: 1000 }, businesses: [{ id: "b_a" }, { id: "b_b" }, { id: "b_c" }], quotes: [], recommended_quote_id: null, approval: null, rejected: [], ...extra }) as unknown as DealBoardView;

  it("reads the lead quote against the budget, counting businesses once", () => {
    const f = boardFigures(board({ quotes: [q("a", 900, { negotiated_from: 1000 }), q("b", 1200), q("b2", 1100, { business_id: "b_b" }), q("n", null)], recommended_quote_id: "a" }));
    expect(f).toEqual({ lead: { business: "Biz a", total_usd: 900 }, budget: 1000, againstBudget: -100, quoted: 2, asked: 3, saved: 100 });
  });

  it("has nothing to say about a price it doesn't have", () => {
    expect(boardFigures(board())).toEqual({ lead: null, budget: 1000, againstBudget: null, quoted: 0, asked: 3, saved: 0 });
  });

  it("reads the board the same way the tables do: no suspicious lead, none on a stopped deal", () => {
    const quotes = [q("scam", 100, { flags: ["prompt_injection"] }), q("real", 900)];
    expect(boardFigures(board({ quotes })).lead?.business).toBe("Biz real");
    const stopped = board({ quotes, recommended_quote_id: "real", job: { requirements: [], budget_usd: 1000, state: "cancelled" } as unknown as DealBoardView["job"] });
    expect(boardFigures(stopped).lead).toBeNull();
  });

  it("needs two priced quotes to compare", () => {
    expect(compareMatrix(board({ quotes: [q("a", 900), q("n", null)] }))).toBeNull();
  });

  it("lines quotes up lowest first, marks the single lowest total and keeps only rows someone stated", () => {
    const m = compareMatrix(board({ quotes: [q("b", 1200, { deposit_usd: 100 }), q("a", 900)], recommended_quote_id: "a" }))!;
    expect(m.columns.map((c) => [c.business, c.recommended])).toEqual([["Biz a", true], ["Biz b", false]]);
    expect(m.rows[0]).toEqual({ label: "Total", cells: [{ text: "$900", tone: "best" }, { text: "$1,200" }] });
    const row = (label: string) => m.rows.find((r) => r.label === label);
    expect(row("Against budget")?.cells).toEqual([{ text: "$100 under" }, { text: "$200 over", tone: "miss" }]);
    expect(row("Deposit")?.cells).toEqual([{ text: "Not stated", tone: "muted" }, { text: "$100" }]);
    expect(row("Each")).toBeUndefined();
    expect(row("Cancellation")).toBeUndefined();
  });

  it("never praises a flagged quote as lowest, and says what's wrong with it", () => {
    const m = compareMatrix(board({ quotes: [q("scam", 100, { flags: ["unverified_sender"] }), q("real", 900), q("more", 1000)] }))!;
    expect(m.rows[0]!.cells.map((c) => c.tone)).toEqual([undefined, "best", undefined]);
    expect(m.rows.find((r) => r.label === "Check first")?.cells).toEqual([{ text: "Unverified sender", tone: "miss" }, { text: "Nothing flagged", tone: "muted" }, { text: "Nothing flagged", tone: "muted" }]);
    expect(compareMatrix(board({ quotes: [q("a", 900), q("b", 950)] }))!.rows.some((r) => r.label === "Check first")).toBe(false);
  });

  it("doesn't call a tie the lowest", () => {
    const m = compareMatrix(board({ quotes: [q("a", 900), q("b", 900)] }))!;
    expect(m.rows[0]!.cells.every((c) => !c.tone)).toBe(true);
  });
});
