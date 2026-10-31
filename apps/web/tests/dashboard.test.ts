// The deal dashboard's pure logic: state words, the step timeline, money/time formatting, quote
// ordering against fixtures/views/deal-board.json, SSE frames, the stream loop and the action handler
// with a fake Haggle client. No network.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HaggleError } from "../lib/haggle.ts";
import { errorJson, runDealAction } from "../lib/dashboard/actions.ts";
import {
  activity, ago, boardStatus, dealCounts, dealLine, flagTone, flagWords, humanNext, isApprovable, isTerminal, money, mustHaves, payNowLine, priceCheckWords, progress,
  plainNote, possessive, recommendationReason, recommendationSentence, savedBy, sentence, sheetQuotes, sortQuotes, stamp, stateWords, timeline,
} from "../lib/dashboard/format.ts";
import { backoffMs, cursorOf, streamUrl } from "../lib/dashboard/live.ts";
import { parseCursor, sseComment, sseFrame, streamUpdates } from "../lib/dashboard/stream.ts";
import type { DealBoardView, WaitResult } from "../lib/dashboard/types.ts";

const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/views/deal-board.json", import.meta.url), "utf8")) as DealBoardView;

/** A fake client: each call returns the next scripted answer (or throws it), and records the call. */
function fakeHaggle(script: (WaitResult | Record<string, unknown> | Error)[]) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    async callTool<T>(name: string, args: Record<string, unknown> = {}) {
      calls.push({ name, args });
      const next = script.shift();
      if (!next) throw new Error("script exhausted");
      if (next instanceof Error) throw next;
      return { data: next as T, text: "", meta: { "haggle/approval": { code: "1234" } } };
    },
  };
}
const wait = (cursor: string, state: string, updates: WaitResult["updates"] = [], timed_out = updates.length === 0): WaitResult => ({ job_id: "job_demo", state, cursor, updates, timed_out });
const frames = (out: string[]) => out.map((f) => ({ event: /^event: (\w+)/.exec(f)?.[1], data: JSON.parse(/\ndata: (.*)\n/.exec(f)?.[1] ?? "null") }));

describe("state and timeline", () => {
  it("says each state in plain words and knows the terminal ones", () => {
    expect(stateWords("awaiting_approval")).toBe("Waiting for your approval");
    expect(stateWords("collecting")).toBe("Collecting quotes");
    expect(stateWords("some_new_state")).toBe("some new state");
    expect(["paid", "confirmed", "cancelled", "failed"].every(isTerminal)).toBe(true);
    expect(isTerminal("negotiating")).toBe(false);
  });

  it("marks steps done / current / todo from the state", () => {
    const s = (state: string) => timeline(state).steps.map((x) => x.status);
    expect(s("created")).toEqual(["current", "todo", "todo", "todo", "todo"]);
    expect(s("negotiating")).toEqual(["done", "done", "current", "todo", "todo"]);
    expect(s("paying")).toEqual(["done", "done", "done", "done", "current"]);
    expect(s("paid")).toEqual(["done", "done", "done", "done", "done"]);
    expect(timeline("paid").steps.at(-1)!.label).toBe("Paid");
    expect(timeline("confirmed").steps.at(-1)!.label).toBe("Confirmed");
    const c = timeline("cancelled");
    expect(c.stopped).toBe(true);
    expect(c.steps.every((x) => x.status === "todo")).toBe(true);
  });
});

describe("humanNext: the deal page's next step, for a person (board.next is written for agents)", () => {
  const board = (patch: Partial<DealBoardView> & { state?: string }): DealBoardView => {
    const { state, ...rest } = patch;
    return { ...fixture, ...rest, job: { ...fixture.job!, state: (state ?? fixture.job!.state) as never } } as DealBoardView;
  };
  it("never shows the agent's tool-call hint", () => {
    const b = board({ next: "Answer with answer_business(job_id, question_id='qn_1', answer)", state: "collecting" });
    expect(humanNext(b)).not.toMatch(/answer_business|job_id|wait_for_update/);
  });
  it("a business's open question comes first", () => {
    const q = { question_id: "qn_1", business: "Sunset Kitchen", text: "Plates?" } as DealBoardView["open_questions"][number];
    expect(humanNext(board({ state: "collecting", open_questions: [q] }))).toBe("Sunset Kitchen asked a question. Answer it below so it can quote.");
  });
  it("each state reads as a plain sentence", () => {
    expect(humanNext(board({ state: "collecting", open_questions: [], businesses: [], quotes: [] }))).toMatch(/^Waiting for quotes/);
    expect(humanNext(board({ state: "negotiating", open_questions: [] }))).toMatch(/^Haggle is negotiating/);
    expect(humanNext(board({ state: "awaiting_approval", open_questions: [] }))).toMatch(/approve/i);
    expect(humanNext(board({ state: "paid", open_questions: [] }))).toMatch(/^Done/);
    expect(humanNext(board({ state: "cancelled", open_questions: [] }))).toMatch(/stopped/);
  });
  it("after approval the purchase's own next step is used", () => {
    const purchase = { next: "Wait for Bay Catering to confirm the booking." } as DealBoardView["purchase"];
    expect(humanNext(board({ state: "paying", open_questions: [], purchase }))).toBe("Wait for Bay Catering to confirm the booking.");
  });
});

describe("formatting", () => {
  it("formats money; an unknown total is never $0", () => {
    expect(money(1035)).toBe("$1,035");
    expect(money(310.5)).toBe("$310.50");
    expect(money(null)).toBe("not stated");
    expect(money(undefined)).toBe("not stated");
  });

  it("formats times relative to now, and as a stable UTC stamp", () => {
    const now = new Date("2026-10-22T12:00:00Z");
    expect(ago("2026-10-22T11:59:30Z", now)).toBe("just now");
    expect(ago("2026-10-22T11:55:00Z", now)).toBe("5 min ago");
    expect(ago("2026-10-22T09:00:00Z", now)).toBe("3 h ago");
    expect(ago("2026-10-21T10:00:00Z", now)).toBe("1 day ago");
    expect(ago("2026-10-01T10:00:00Z", now)).toBe("Oct 1, 2026");
    expect(ago("nonsense", now)).toBe("");
    expect(stamp("2026-10-22T15:04:00Z")).toBe("Oct 22, 15:04 UTC");
    expect(dealLine({ quantity: 40, date: "2026-10-24", area: "SF" })).toBe("40 people · 2026-10-24 · SF");
    expect(dealLine({})).toBe("");
  });

  it("a suspiciously low price is a risk, never a good price; a confirmed or high one is a warning", () => {
    expect(flagWords("price_implausible")).toBe("suspiciously low price");
    expect(flagTone("price_implausible")).toBe("risk");
    expect(flagWords("price_confirmed_unusual")).toBe("unusually low (vendor confirmed)");
    expect(flagTone("price_confirmed_unusual")).toBe("warn");
    expect(flagWords("price_unusually_high")).toBe("unusually high price");
    expect(priceCheckWords("too_low")).toBe("Suspiciously low");
    expect(priceCheckWords("good")).toBe("Good price");
  });
});

describe("quotes comparison (fixture board)", () => {
  it("puts the recommended quote first, then approvable, then excluded and old versions", () => {
    const board: DealBoardView = {
      ...fixture,
      recommended_quote_id: "q_harbor_2",
      quotes: [
        { ...fixture.quotes[0]!, quote_id: "a_old", status: "superseded" },
        { ...fixture.quotes[0]!, quote_id: "b_excl" },
        { ...fixture.quotes[0]!, quote_id: "c_ok" },
        { ...fixture.quotes[1]!, quote_id: "q_harbor_2" },
        { ...fixture.quotes[0]!, quote_id: "d_null", total_usd: null },
      ],
      rejected: [{ business_id: "x", quote_id: "b_excl", reason: "requirement_unmet", detail: "only 6 vegetarian" }],
      quote_status: { c_ok: { approvable: true }, q_harbor_2: { approvable: true }, b_excl: { approvable: false } },
    };
    expect(sortQuotes(board).map((r) => [r.quote.quote_id, r.rank])).toEqual([
      ["q_harbor_2", "recommended"], ["c_ok", "eligible"], ["d_null", "other"], ["b_excl", "excluded"], ["a_old", "old"],
    ]);
    expect(isApprovable(board.quotes[2]!, board)).toBe(true);
    expect(isApprovable(board.quotes[4]!, board)).toBe(false); // no stated total
    expect(isApprovable(board.quotes[0]!, board)).toBe(false); // superseded
  });

  it("sorts the real fixture without losing a quote, recommended first", () => {
    const rows = sortQuotes(fixture);
    expect(rows).toHaveLength(fixture.quotes.length);
    if (fixture.recommended_quote_id) expect(rows[0]!.quote.quote_id).toBe(fixture.recommended_quote_id);
  });

  it("explains the recommendation from selection, then the value winner, then the note", () => {
    expect(recommendationReason({ recommended_quote_id: "q1", selection: { q1: { status: "recommended", reason: "cheapest compliant" } } })).toBe("cheapest compliant");
    expect(recommendationReason({ recommended_quote_id: "q1", value: { explanation: { winner: "best value", others: [] } } })).toBe("best value");
    expect(recommendationReason({ recommended_quote_id: "q1", recommendation_note: "note" })).toBe("note");
    expect(recommendationReason({})).toBeNull();
  });

  it("states the recommendation's reason whole, never cut mid-word", () => {
    const sel = (reason: string) => ({ recommended_quote_id: "q1", selection: { q1: { status: "recommended" as const, reason } } });
    expect(recommendationSentence(sel("recommended: meets every requirement and the budget, fresh, best value of the q…"))).toBe("Meets every requirement and the budget, fresh.");
    expect(recommendationSentence(sel("recommended: cheapest compliant"))).toBe("Cheapest compliant.");
    expect(recommendationSentence({ ...sel("recommended: meets every requirement, best val…"), value: { explanation: { winner: "Best value for 40 people.", others: [] } } })).toBe("Best value for 40 people.");
    expect(recommendationSentence({})).toBeNull();
  });
});

describe("SSE frames and the client helpers", () => {
  it("encodes one-line frames and comments", () => {
    expect(sseFrame("update", { cursor: "4", text: "a\nb" })).toBe('event: update\ndata: {"cursor":"4","text":"a\\nb"}\n\n');
    expect(sseComment("heart\nbeat")).toBe(": heart beat\n\n");
  });

  it("accepts digit cursors only and builds the resume URL", () => {
    expect(parseCursor("12")).toBe("12");
    expect(parseCursor("1x")).toBeNull();
    expect(parseCursor(null)).toBeNull();
    expect(streamUrl("job/1", null)).toBe("/api/deals/job%2F1/stream");
    expect(streamUrl("job_1", "7")).toBe("/api/deals/job_1/stream?cursor=7");
    expect(cursorOf('{"cursor":"9"}')).toBe("9");
    expect(cursorOf("nope")).toBeNull();
    expect([1, 2, 3, 10].map(backoffMs)).toEqual([1000, 2000, 4000, 30000]);
  });
});

describe("streamUpdates", () => {
  it("learns the current cursor first, emits updates, and stops on a terminal state", async () => {
    const haggle = fakeHaggle([
      wait("5", "collecting", [{ type: "reply", business_id: "b", summary: "old" }], false),
      wait("5", "collecting"),
      wait("7", "awaiting_approval", [{ type: "quote", quote_id: "q", business_id: "b", total_usd: 900, round: 1 }]),
      wait("8", "paid", [{ type: "state", from: "paying", to: "paid" }]),
    ]);
    const out: string[] = [];
    const r = await streamUpdates(haggle, "job_demo", null, new AbortController().signal, (f) => out.push(f));
    expect(r).toEqual({ reason: "terminal", cursor: "8" });
    expect(haggle.calls[0]).toEqual({ name: "wait_for_update", args: { job_id: "job_demo", cursor: "0", timeout_s: 0 } });
    expect(haggle.calls[1]!.args).toEqual({ job_id: "job_demo", cursor: "5", timeout_s: 25 });
    expect(haggle.calls[2]!.args.cursor).toBe("5");
    expect(haggle.calls[3]!.args.cursor).toBe("7");
    const f = frames(out);
    // The page already shows the old state: the priming read's updates aren't re-sent.
    expect(f.map((x) => x.event)).toEqual(["ready", "update", "update", "end"]);
    expect(f[1]!.data).toMatchObject({ cursor: "7", state: "awaiting_approval", updates: [{ type: "quote" }] });
    expect(f[3]!.data).toEqual({ reason: "terminal", cursor: "8", state: "paid" });
    expect(out.join("")).not.toContain("1234"); // tool meta (approval codes) never reaches the stream
  });

  it("resumes from a given cursor and ends at the time limit with the cursor to reconnect with", async () => {
    let t = 0;
    const haggle = fakeHaggle([wait("3", "collecting"), wait("3", "collecting"), wait("3", "collecting")]);
    const out: string[] = [];
    const r = await streamUpdates(haggle, "job_demo", "3", new AbortController().signal, (f) => out.push(f), {
      maxMs: 50_000, now: () => (t += 20_000),
    });
    expect(r).toEqual({ reason: "max_duration", cursor: "3" });
    expect(haggle.calls[0]!.args).toMatchObject({ cursor: "3", timeout_s: 25 });
    expect(frames(out).map((x) => x.event)).toEqual(["ready", "end"]);
    expect(frames(out)[1]!.data).toEqual({ reason: "max_duration", cursor: "3" });
  });

  it("ends at once for a deal that is already over", async () => {
    const out: string[] = [];
    const r = await streamUpdates(fakeHaggle([wait("9", "cancelled")]), "job_demo", null, new AbortController().signal, (f) => out.push(f));
    expect(r.reason).toBe("terminal");
    expect(frames(out).map((x) => x.event)).toEqual(["ready", "end"]);
  });

  it("reports the server's refusal as a problem frame with its fix; an abort is silent", async () => {
    const out: string[] = [];
    const refused = fakeHaggle([new HaggleError("job_not_found", "No such deal.", "Call list_deals.")]);
    expect((await streamUpdates(refused, "job_x", null, new AbortController().signal, (f) => out.push(f))).reason).toBe("error");
    expect(frames(out)).toEqual([{ event: "problem", data: { code: "job_not_found", message: "No such deal.", fix: "Call list_deals." } }]);

    const ac = new AbortController();
    const quiet: string[] = [];
    const aborting = { async callTool() { ac.abort(); throw new Error("aborted"); } };
    expect((await streamUpdates(aborting, "job_x", "1", ac.signal, (f) => quiet.push(f))).reason).toBe("aborted");
    expect(frames(quiet).map((x) => x.event)).toEqual(["ready"]);
  });
});

describe("deal actions", () => {
  it("answers a business's question through answer_business and returns data without meta", async () => {
    const haggle = fakeHaggle([{ ok: true, question_id: "qq_1", sent: true, next: "wait_for_update" }]);
    const r = await runDealAction(haggle, "job_demo", { action: "answer_business", question_id: "qq_1", answer: " Yes, a loading dock. " });
    expect(haggle.calls[0]).toEqual({ name: "answer_business", args: { job_id: "job_demo", question_id: "qq_1", answer: "Yes, a loading dock." } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, action: "answer_business", next: "wait_for_update", data: { ok: true, question_id: "qq_1", sent: true, next: "wait_for_update" } });
    expect(JSON.stringify(r.body)).not.toContain("1234");
  });

  it("sends a message (text and/or ask_missing, optional channel) and runs negotiate", async () => {
    const haggle = fakeHaggle([{ sent: true, channel: "email", next: "n" }, { sent: true, channel: "email", next: "n" }, { round: 2, asked: [], next: "n" }]);
    await runDealAction(haggle, "job_demo", { action: "send_message", business_id: "biz_harbor_table", text: "Can you deliver by 11?", channel: "imessage" });
    await runDealAction(haggle, "job_demo", { action: "send_message", business_id: "biz_harbor_table", text: "  ", ask_missing: true });
    await runDealAction(haggle, "job_demo", { action: "negotiate" });
    expect(haggle.calls.map((c) => c.args)).toEqual([
      { job_id: "job_demo", business_id: "biz_harbor_table", text: "Can you deliver by 11?", channel: "imessage" },
      { job_id: "job_demo", business_id: "biz_harbor_table", ask_missing: true },
      { job_id: "job_demo" },
    ]);
  });

  it("refuses bad input before calling the server: empty message, unconfirmed cancel, unknown action, bad job id", async () => {
    const haggle = fakeHaggle([]);
    for (const body of [
      { action: "send_message", business_id: "biz_harbor_table", text: "" },
      { action: "cancel_deal" },
      { action: "cancel_deal", confirm: false },
      { action: "approve", quote_id: "q_1" },
      { action: "pay", quote_id: "q_1" },
      null,
    ]) {
      const r = await runDealAction(haggle, "job_demo", body);
      expect(r.status).toBe(400);
      expect(r.body.ok).toBe(false);
    }
    expect((await runDealAction(haggle, "x", { action: "negotiate" })).body).toMatchObject({ ok: false, error: { code: "bad_job_id" } });
    expect(haggle.calls).toHaveLength(0);
  });

  it("cancels only with confirm: true, and shows the server's error with its fix", async () => {
    const ok = fakeHaggle([{ ok: true, state: "cancelled", next: "Deal cancelled." }]);
    expect((await runDealAction(ok, "job_demo", { action: "cancel_deal", confirm: true })).body).toMatchObject({ ok: true, next: "Deal cancelled." });
    expect(ok.calls[0]).toEqual({ name: "cancel_deal", args: { job_id: "job_demo" } });

    const refused = fakeHaggle([new HaggleError("no_rounds_left", "No negotiation round left.", "Choose among the current quotes.", "get_quotes")]);
    const r = await runDealAction(refused, "job_demo", { action: "negotiate" });
    expect(r).toEqual({ status: 422, body: { ok: false, error: { code: "no_rounds_left", message: "No negotiation round left.", fix: "Choose among the current quotes." }, next: "get_quotes" } });
  });

  it("maps an HTTP refusal or an unknown failure to 502", () => {
    expect(errorJson(new HaggleError("UNAUTHORIZED", "Unknown token.", "Check HAGGLE_SERVICE_TOKEN.", null, 401)).status).toBe(502);
    expect(errorJson(new Error("boom"))).toMatchObject({ status: 502, body: { error: { code: "unreachable" } } });
  });
});

describe("the deal board (fixture board)", () => {
  const board = (patch: Partial<DealBoardView> & { state?: string } = {}): DealBoardView => {
    const { state, ...rest } = patch;
    return { ...fixture, ...rest, job: { ...fixture.job!, state: (state ?? fixture.job!.state) as never } } as DealBoardView;
  };

  it("says what is happening now, with a tone for the dot", () => {
    expect(boardStatus(board())).toEqual({ tone: "hold", words: "A business needs your answer" });
    const quiet = { open_questions: [] };
    expect(boardStatus(board({ ...quiet, state: "awaiting_approval", ready: true }))).toEqual({ tone: "hold", words: "Quotes are final, ready for your approval" });
    expect(boardStatus(board({ ...quiet, state: "collecting" }))).toEqual({ tone: "live", words: "5 of 6 quoted" });
    expect(boardStatus(board({ ...quiet, state: "contacting", quotes: [] }))).toEqual({ tone: "live", words: "Contacting 6 businesses" });
    const calling = board({ ...quiet, state: "collecting", businesses: [{ ...fixture.businesses[2]!, status: "on_call" }] });
    expect(boardStatus(calling)).toEqual({ tone: "live", words: "On a call with Mission Eats" });
    expect(boardStatus(board({ state: "paid" }))).toEqual({ tone: "ok", words: "Paid" });
    expect(boardStatus(board({ state: "cancelled" })).tone).toBe("idle");
  });

  it("sorts the sheet by total, keeps can't-win quotes and earlier versions apart", () => {
    const b = board({
      quotes: [
        ...fixture.quotes,
        { ...fixture.quotes[1]!, quote_id: "q_harbor_1", total_usd: 1150, negotiated_from: undefined, status: "superseded" },
        { ...fixture.quotes[2]!, quote_id: "q_none", business_id: "b_none", total_usd: null },
      ],
      rejected: [{ business_id: "biz_quickquote_deli", quote_id: "q_quickquote_1", reason: "unsafe", detail: "asked to pay at a link" }],
      quote_status: { q_bay_1: { approvable: true }, q_harbor_2: { approvable: true }, q_mission_1: { approvable: true }, q_golden_1: { approvable: false } },
    });
    const s = sheetQuotes(b);
    expect(s.rows.map((r) => r.quote.quote_id)).toEqual(["q_golden_1", "q_bay_1", "q_harbor_2", "q_mission_1", "q_none"]);
    expect(s.rows.find((r) => r.quote.quote_id === "q_bay_1")).toMatchObject({ rank: "recommended", selectable: true });
    expect(s.rows.find((r) => r.quote.quote_id === "q_golden_1")!.selectable).toBe(false);
    expect(s.rows.at(-1)!.selectable).toBe(false); // no stated total
    expect(s.excluded.map((r) => r.quote.quote_id)).toEqual(["q_quickquote_1"]);
    expect(s.older.map((q) => q.quote_id)).toEqual(["q_harbor_1"]);
    // An approved quote stays choosable (its panel shows Pay) even when no longer approvable.
    const approved = sheetQuotes({ ...b, quote_status: {}, approval: { approval_id: "a", quote_id: "q_mission_1", status: "approved", channel: "web" } });
    expect(approved.rows.find((r) => r.quote.quote_id === "q_mission_1")!.selectable).toBe(true);
  });

  it("marks a saving only when there is a real earlier price above the total", () => {
    expect(savedBy({ negotiated_from: 1150, total_usd: 1035 })).toBe(115);
    expect(savedBy({ negotiated_from: 1000, total_usd: 1035 })).toBeNull();
    expect(savedBy({ total_usd: 1035 })).toBeNull();
    expect(savedBy({ negotiated_from: 1150, total_usd: null })).toBeNull();
  });

  it("counts must-haves met and names the missing one", () => {
    const golden = fixture.quotes[3]!;
    const b = board({
      compliance: {
        q_golden_1: {
          status: "noncompliant",
          issues: [{ code: "requirement_unmet", text: "doesn't meet: At least 12 vegetarian meals (only 6 of 12)" }, { code: "over_budget", text: "$80 over the $1,200 budget" }],
        },
        q_bay_1: { status: "compliant", issues: [] },
      },
    });
    expect(mustHaves(golden, b)).toEqual({ total: 3, met: 2, unmet: ["At least 12 vegetarian meals (only 6 of 12)"], unconfirmed: [], other: ["$80 over the $1,200 budget"] });
    expect(mustHaves(fixture.quotes[0]!, b)).toMatchObject({ total: 3, met: 3, unmet: [] });
    // No compliance on the board: meets_requirements decides, and a miss can't be counted.
    expect(mustHaves(fixture.quotes[0]!, board())).toMatchObject({ met: 3 });
    expect(mustHaves(golden, board())).toMatchObject({ met: null });
    expect(mustHaves(golden, { ...board(), job: { ...fixture.job!, requirements: [] } })).toBeNull();
  });

  it("says what the approval bar charges now", () => {
    expect(payNowLine(1150, 5)).toBe("$5 deposit now, $1,150 total");
    expect(payNowLine(1150, undefined)).toBe("$1,150 now, the full total (no deposit stated)");
    expect(payNowLine(1150, 1150)).toBe("$1,150 now, the full total (no deposit stated)");
  });

  it("lists activity per business, newest first, in plain words", () => {
    const b = board({
      businesses: [
        ...fixture.businesses.slice(0, 5),
        { ...fixture.businesses[5]!, status: "declined" },
        { id: "b_call", name: "Taco Town", channel: "phone", status: "on_call", last_event: "Call connected" },
      ],
      negotiation: [{ business_id: "biz_harbor_table", business: "Harbor Table", round: 2, target_total_usd: 995, basis_quote_id: "q_bay_1", outcome_total_usd: null }],
    });
    const a = activity(b);
    expect(a.map((x) => x.business)).toEqual(["Harbor Table", "Sunset Kitchen", "Golden Grill", "Mission Eats", "QuickQuote Deli", "Bay Catering", "Taco Town"]);
    expect(a[0]).toMatchObject({ text: "Countered Harbor Table with Bay Catering's $995", tone: "live" });
    expect(a[1]).toMatchObject({ text: "Sunset Kitchen asked a question", tone: "hold" });
    expect(a.find((x) => x.business === "Mission Eats")).toMatchObject({ text: "Mission Eats quoted $1,080", detail: "Call ended, completed, 2m 14s" });
    expect(a.find((x) => x.business === "Taco Town")).toMatchObject({ text: "On the call with Taco Town now", live: true });
    expect(a.find((x) => x.business === "QuickQuote Deli")!.tone).toBe("risk");
    const harbor = activity(board({ businesses: [{ ...fixture.businesses[1]!, status: "quoted" }] }))[0]!;
    expect(harbor.text).toBe("Harbor Table came down from $1,150 to $1,035");
    expect(activity(board({ businesses: [{ ...fixture.businesses[4]!, id: "x" }], open_questions: [] }))[0]!.text).toBe("Emailed Sunset Kitchen");
  });

  it("shows honest progress: counts from the board, only steps that happened or are next", () => {
    const p = (b: DealBoardView) => progress(b).map((s) => [s.label, s.status]);
    expect(p(board())).toEqual([
      ["Contacted 6 businesses", "done"], ["5 of 6 quoted", "done"], ["Negotiate", "current"], ["Your approval", "todo"], ["Payment", "todo"],
    ]);
    const paid = board({ state: "paid", payment: { status: "paid", simulated: true }, approval: { approval_id: "a", quote_id: "q_bay_1", status: "used", channel: "web" } });
    expect(p(paid).slice(-2)).toEqual([["You approved a quote", "done"], ["Paid (simulated)", "done"]]);
    expect(p(board({ state: "cancelled" })).at(-1)).toEqual(["Cancelled", "current"]);
    expect(p(board({ state: "contacting", quotes: [] }))[0]).toEqual(["Contacted 6 businesses", "current"]);
  });

  it("formats a deals-list row's counts and the server's one-line notes", () => {
    expect(dealCounts({ businesses: 6, quotes: 3 })).toBe("6 contacted, 3 quoted");
    expect(dealCounts({})).toBe("");
    expect(sentence("call ended · completed")).toBe("Call ended, completed");
    expect(plainNote("Counteroffer to Bay Catering over A2A: match 1070 (real quote q_7b52862922fe4ce49f6e), a real cheaper quote")).toBe(
      "Counteroffer to Bay Catering over A2A: match 1070, a real cheaper quote",
    );
    expect(plainNote("flagged: requirement_unmet for job_ff32d2f2815c")).toBe("Flagged: requirement unmet for");
    expect(possessive("Mission Eats")).toBe("Mission Eats'");
    expect(possessive("Bay Catering")).toBe("Bay Catering's");
  });

  it("never repeats a counteroffer's internal note, and says when a callback is scheduled", () => {
    const b = board({
      businesses: [{ ...fixture.businesses[1]!, last_event: "Counteroffer: match 995 (real quote q_bay_1abcdef)" }],
      negotiation: [{ business_id: "biz_harbor_table", business: "Harbor Table", round: 2, target_total_usd: 995, basis_quote_id: "q_bay_1", outcome_total_usd: null, scheduled_for: "2026-10-22T16:00:00Z" }],
    });
    expect(activity(b)[0]).toMatchObject({ text: "Countered Harbor Table with Bay Catering's $995", detail: "Callback scheduled for Oct 22, 16:00 UTC" });
    expect(activity({ ...b, negotiation: [{ ...b.negotiation![0]!, scheduled_for: undefined }] })[0]!.detail).toBeUndefined();
  });
});
