// Release acceptance (Agent E, rc1): the release criteria that can be automated, checked over the real
// MCP HTTP interface of the production build (`mcp-use start`) in MOCK mode. No outreach, no Stripe call.
// Memory store by default; set HAGGLE_TEST_DATABASE_URL to run the same checks on Postgres (use a
// throwaway database: see scripts/acceptance/sim-journey.sh).
//
// Known product defects are pinned with `defect(...)`: by default they run as `it.fails` (green while the
// defect exists, red once it's fixed, so the marker gets removed); ACCEPTANCE_STRICT=1 runs them as plain
// tests, which fail until the product is fixed. Run `npm run build -w @haggle/mcp` first.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const APP_DIR = join(import.meta.dirname, "..");
const BIN = [join(APP_DIR, "node_modules/.bin/mcp-use"), join(APP_DIR, "../../node_modules/.bin/mcp-use")].find((p) => existsSync(p)) ?? "mcp-use";
const DB = process.env.HAGGLE_TEST_DATABASE_URL;
const defect = process.env.ACCEPTANCE_STRICT ? it : it.fails;

const freePort = () => new Promise<number>((res, rej) => { const s = createServer().once("error", rej).listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });
let proc: ChildProcess | null = null;
let base = "";
let rid = 0;

type R = { isError?: boolean; content: { text: string }[]; structuredContent?: any };
async function call(name: string, args: Record<string, unknown> = {}): Promise<R> {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method: "tools/call", params: { name, arguments: args } }) });
  const t = await r.text();
  const line = t.split("\n").find((l) => l.startsWith("data: "));
  const msg = JSON.parse(line ? line.slice(6) : t);
  if (msg.error) throw new Error(`${name}: ${JSON.stringify(msg.error)}`);
  return msg.result;
}
const err = (r: R) => JSON.parse(r.content[0]!.text).error as { code: string; message: string; fix: string };

/** "next Saturday" as a person means it (a Saturday → the one after). */
const SAT = (() => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + (((6 - d.getUTCDay() + 7) % 7) || 7)); return d.toISOString().slice(0, 10); })();
/** What Claude sends for "I need catering for 50 people in San Francisco next Saturday. Find me the best deal." */
const ONE_SENTENCE = { request: { what: "catering", quantity: 50, date: SAT, area: "San Francisco", unit: "people" } };

/** Follow a job until its quotes are final; every vendor question gets a neutral answer. Returns the board and every quote event seen. */
async function runToReady(jobId: string) {
  let cursor = "0";
  let board: any = null;
  const quoteEvents: { quote_id: string; business_id: string; total_usd: number | null; round: number }[] = [];
  const updates: any[] = [];
  for (let i = 0; i < 60; i++) {
    const w = (await call("wait_for_update", { job_id: jobId, cursor, timeout_s: 1 })).structuredContent;
    cursor = w.cursor;
    updates.push(...w.updates);
    for (const u of w.updates) if (u.type === "quote") quoteEvents.push(u);
    board = (await call("get_quotes", { job_id: jobId })).structuredContent;
    for (const q of board.open_questions) await call("answer_business", { job_id: jobId, question_id: q.question_id, answer: "Yes, please include them." });
    if (board.ready && !board.open_questions.length) break;
  }
  return { board, quoteEvents, updates };
}

let oldJob = "";
let job = "";
let dealText = "";
let run: Awaited<ReturnType<typeof runToReady>>;

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const brain = join(mkdtempSync(join(tmpdir(), "haggle-accept-")), "brain.json");
  proc = spawn(BIN, ["start"], { cwd: APP_DIR, stdio: "ignore", env: { ...process.env, PORT: String(port), HAGGLE_MODE: "mock", HAGGLE_SIM_DELAY_SCALE: "0", HAGGLE_MOCK_BRAIN_FILE: brain, ...(DB ? { HAGGLE_MOCK_DATABASE_URL: DB } : {}) } });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }
  // An unrelated, older deal exists before the user's request.
  oldJob = (await call("deal", { request: { what: "hackathon catering", quantity: 200, date: SAT, area: "San Francisco, CA", venue: "YC HQ" }, budget_usd: 5000 })).structuredContent.job_id;
  expect(oldJob).toMatch(/^job_/);
}, 60_000);
afterAll(() => { proc?.kill(); });

describe(`release acceptance${DB ? " (Postgres)" : " (memory)"}`, { timeout: 120_000 }, () => {
  it("one-sentence request: a NEW job whose board is that job; nothing invented", async () => {
    const r = await call("deal", ONE_SENTENCE);
    expect(r.isError).toBeFalsy();
    const v = r.structuredContent;
    expect(v).toMatchObject({ ok: true, mode: "mock" });
    job = v.job_id;
    dealText = r.content[0]!.text;
    expect(job).not.toBe(oldJob);
    expect(v.job.id).toBe(job);
    expect(v.request_details).toMatchObject({ what: "catering", headcount: 50, date: SAT, requirements: [], budget_usd: null });
    expect(v.request_details.time).toBeUndefined();
    expect(v.job.budget_usd).toBeUndefined();
    expect(v.businesses.every((b: { simulated: boolean }) => b.simulated)).toBe(true);
    expect(v.next).toContain(job);
    expect(JSON.stringify(v)).not.toContain(oldJob);
    expect(r.content[0]!.text).toMatch(/^\[DEMO\]/);
  });

  it("the text summary for a no-budget deal doesn't print a placeholder budget", async () => {
    // Observed: "…San Francisco; budget ?." (index.ts deal text, usd(null)): a model may relay the '?'.
    expect(dealText).not.toMatch(/budget \?/);
  });

  it("get_quotes without a job id never shows a board (no unrelated deal)", async () => {
    const r = await call("get_quotes", {});
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.job ?? null).toBeNull();
    expect(err(r).code).toBe("job_id_required");
    expect(err(r).message).toContain(job); // it lists recent deals so the agent can pick
  });

  it("quotes arrive asynchronously, negotiation cites only real quotes, the job ends ready with a current recommendation", async () => {
    run = await runToReady(job);
    const { board, quoteEvents, updates } = run;
    expect(board.job_id).toBe(job);
    expect(board.ready).toBe(true);
    expect(board.quotes.length).toBeGreaterThanOrEqual(3);
    // Every counteroffer names a quote id that really exists on this job (or the buyer's own target; none here).
    const seen = new Set(quoteEvents.map((q) => q.quote_id));
    const counters = updates.filter((u) => u.type === "reply" && /^Counteroffer/.test(u.summary ?? ""));
    expect(counters.length).toBeGreaterThan(0);
    for (const c of counters) {
      const cited = /real quote (q_\w+)/.exec(c.summary)?.[1];
      expect(cited, c.summary).toBeTruthy();
      expect(seen.has(cited!)).toBe(true);
      expect(c.summary).not.toMatch(/target/); // no budget was given, so no target may be claimed
    }
    // At least one vendor revised; the revision is recorded against its first quote.
    const revised = Object.values(board.stages as Record<string, any>).filter((s) => s.stage === "vendor_revised");
    expect(revised.length).toBeGreaterThan(0);
    for (const s of revised) expect(s.current_total_usd).toBeLessThan(s.first_total_usd);
    // The recommendation is a current, eligible quote on this job.
    const rec = board.quotes.find((q: { quote_id: string }) => q.quote_id === board.recommended_quote_id);
    expect(rec).toBeTruthy();
    expect(board.rejected.map((x: { quote_id?: string }) => x.quote_id)).not.toContain(rec.quote_id);
    // The injection vendor never wins and is shown as rejected.
    expect(rec.flags).not.toContain("external_payment_link");
    expect(rec.flags).not.toContain("prompt_injection");
  });

  it("the model-visible text names the business for every quote (wait_for_update) and lists every current total (get_quotes)", async () => {
    // Real Claude (scripts/acceptance/local-journey.mjs) reported "Harbor Table $1,070" (that was Mission Eats)
    // and "Bay Catering $1,070 or $1,120 … my update feed didn't label which is which": index.ts:315 renders a
    // quote update as "quote q_…: $1,070 (round 1)" without the business, and index.ts:89 only names the best quote.
    const w = await call("wait_for_update", { job_id: job, cursor: "0", timeout_s: 1 });
    const names = new Map((run.board.businesses as { business_id?: string; id?: string; name: string }[]).map((b) => [b.business_id ?? b.id, b.name]));
    const quoteLines = w.content[0]!.text.split("\n").filter((l) => /^quote q_/.test(l));
    expect(quoteLines.length).toBeGreaterThan(0);
    for (const l of quoteLines) expect([...names.values()].some((n) => l.includes(n)), l).toBe(true);
    const g = (await call("get_quotes", { job_id: job })).content[0]!.text;
    for (const q of run.board.quotes as { business: string; total_usd: number | null }[]) if (q.total_usd !== null) expect(g, q.business).toContain(`$${q.total_usd.toLocaleString("en-US")}`);
  });

  defect("the recommended quote can be approved (or the board says why not instead of 'approve the recommended quote')", async () => {
    // Repro: one-sentence request, no budget → recommended Golden Grill $860, no deposit; payment = full total
    // $860 > $500 per-payment ceiling → approve refuses over_cap, while get_quotes.next says
    // "Quotes are final. Call get_quotes, then approve(job_id, quote_id) for the recommended quote."
    // engine.ts:1712 (nextHint) and the ranking ignore engine.ts:1940 (over_cap in requestApproval).
    const { board } = run;
    const r = await call("approve", { job_id: job, quote_id: board.recommended_quote_id });
    const blocked = r.isError ? err(r).code : null;
    if (blocked) expect(board.next).not.toMatch(/approve\(job_id, quote_id\) for the recommended quote/);
    expect(blocked).toBeNull();
  });

  it("approval is tied to the exact quote version: superseded, ineligible or unapproved quotes can't be approved or paid", async () => {
    const { board, quoteEvents } = run;
    const current = new Set(board.quotes.map((q: { quote_id: string }) => q.quote_id));
    const superseded = quoteEvents.find((q) => !current.has(q.quote_id));
    expect(superseded).toBeTruthy();
    const a = await call("approve", { job_id: job, quote_id: superseded!.quote_id });
    expect(a.isError).toBe(true);
    expect(err(a)).toMatchObject({ code: "quote_not_eligible", message: expect.stringContaining("not_current") });
    expect((await call("pay", { job_id: job, quote_id: superseded!.quote_id })).isError).toBe(true);

    const injected = board.quotes.find((q: { flags: string[] }) => q.flags.includes("external_payment_link"));
    expect(injected).toBeTruthy();
    expect(err(await call("approve", { job_id: job, quote_id: injected.quote_id })).code).toBe("quote_not_eligible");

    const anyCurrent = board.quotes.find((q: { quote_id: string; deposit_usd?: number }) => (q.deposit_usd ?? 0) > 0 && q.deposit_usd! <= board.payment_ceiling_usd && !q.flags.includes("external_payment_link"));
    const unpaid = await call("pay", { job_id: job, quote_id: anyCurrent.quote_id });
    expect(err(unpaid).code).toBe("no_approval");
    // A quote id from another job is refused.
    const other = (await call("get_quotes", { job_id: oldJob })).structuredContent.quotes[0];
    if (other) expect(err(await call("approve", { job_id: job, quote_id: other.quote_id })).code).toMatch(/quote_not_found|quote_not_eligible/);
  });

  it("approve → pay is idempotent: one payment, the same intent on retry; no second purchase on the job", async () => {
    const { board } = run;
    const payable = board.quotes.filter((q: { deposit_usd?: number; flags: string[] }) => (q.deposit_usd ?? 0) > 0 && q.deposit_usd! <= board.payment_ceiling_usd && !q.flags.includes("external_payment_link"));
    expect(payable.length).toBeGreaterThanOrEqual(2);
    const [q1, q2] = payable;
    const ap = (await call("approve", { job_id: job, quote_id: q1.quote_id })).structuredContent;
    expect(ap).toMatchObject({ status: "approved", quote_id: q1.quote_id, amount_usd: q1.deposit_usd, order_total_usd: q1.total_usd, mode: "mock" });
    expect(ap.amount_usd).toBeLessThanOrEqual(ap.cap_usd);
    // A second approval while the first is open is refused (one purchase per job).
    expect((await call("approve", { job_id: job, quote_id: q2.quote_id })).isError).toBe(true);
    const [p1, p2] = await Promise.all([call("pay", { job_id: job, quote_id: q1.quote_id }), call("pay", { job_id: job, quote_id: q1.quote_id })]);
    const p3 = await call("pay", { job_id: job, quote_id: q1.quote_id });
    const ids = [p1, p2, p3].map((p) => p.structuredContent?.payment?.payment_intent_id);
    expect(ids[0]).toBeTruthy();
    expect(new Set(ids).size).toBe(1);
    for (const p of [p1, p2, p3]) expect(p.structuredContent).toMatchObject({ status: "paid", amount_usd: q1.deposit_usd });
    expect((await call("pay", { job_id: job, quote_id: q2.quote_id })).isError).toBe(true);
    const paid = (await call("get_quotes", { job_id: job })).structuredContent;
    expect(paid.job.state).toBe("paid");
    expect(paid.payment).toMatchObject({ status: "settled", simulated: true });
    expect(paid.payment.receipt_url).toBeUndefined(); // no fake receipt link for a simulated charge
  });

  it("resumption: list_deals finds this job, get_quotes(job_id) is this job; the older deal is separate", async () => {
    const deals = (await call("list_deals", {})).structuredContent.deals;
    expect(deals.find((d: { job_id: string }) => d.job_id === job)).toMatchObject({ what: "catering", quantity: 50, state: "paid" });
    // Open deals are listed first by design, so after this job is paid the older 200-person deal leads the list
    // and list_deals.next points at it as "the most relevant deal" (see the MATRIX resumption row).
    const b = (await call("get_quotes", { job_id: job })).structuredContent;
    expect(b).toMatchObject({ job_id: job, request_details: { headcount: 50 } });
    const old = (await call("get_quotes", { job_id: oldJob })).structuredContent;
    expect(old.request_details.headcount).toBe(200);
    expect(old.payment ?? null).toBeNull(); // paying one job never touches another
  });

  it("a non-catering request doesn't contact the demo caterers and starts no deal", async () => {
    const before = (await call("list_deals", { limit: 20 })).structuredContent.deals.length;
    const r = await call("deal", { request: { what: "fix a leaking pipe", quantity: 1, date: SAT, area: "San Francisco" } });
    expect(r.isError).toBe(true);
    expect(err(r)).toMatchObject({ code: "no_vendors_for_category", message: expect.stringContaining("Nothing was sent") });
    expect((await call("list_deals", { limit: 20 })).structuredContent.deals.length).toBe(before);
  });

  for (const what of ["post-event cleaning crew for our catered dinner", "repair of a commercial pizza oven", "photographer for a dinner party"]) {
    it(`non-catering work that mentions food ("${what}") doesn't contact the demo caterers`, async () => {
      // apps/mcp/src/businesses.ts:17 — first regex match wins and "catered|pizza|dinner" match catering.
      const r = await call("deal", { request: { what, quantity: 1, date: SAT, area: "San Francisco" }, dry_run: true });
      expect(r.structuredContent?.would_contact ?? []).toHaveLength(0);
    });
  }
});
