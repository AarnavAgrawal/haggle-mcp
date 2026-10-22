// Generates docs/eval-report.md (WS-F) from the simulated evaluation corpus: extraction accuracy of the
// deterministic extractor, orchestration metrics with a scripted agent and a fake clock, and (when the
// server is built) tool calls and response sizes over the real MCP HTTP interface in mock mode.
// Every number is from SIMULATED data. Nothing here contacts a provider: the Claude extractor runs only
// with HAGGLE_EVAL_LIVE=1 and ANTHROPIC_API_KEY set (it calls the Anthropic API; not run by default).
//
//   npx tsx apps/mcp/scripts/eval-report.ts            # writes docs/eval-report.md
//   npx tsx apps/mcp/scripts/eval-report.ts --stdout   # prints it instead
//   npx tsx apps/mcp/scripts/eval-report.ts --no-mcp   # skip the MCP HTTP arm
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { CORPUS_VERSION, loadCorpus } from "../../../packages/engine/eval/corpus.ts";
import { liveExtractor, runExtractionEval, type ExtractionSummary } from "../../../packages/engine/eval/extraction.ts";
import { CORPUS_DEALS, runOrchestration, type DealRun } from "../../../packages/engine/eval/orchestration.ts";

const ROOT = join(import.meta.dirname, "../../..");
const APP = join(ROOT, "apps/mcp");
const args = new Set(process.argv.slice(2));
const LABEL = "simulated corpus, deterministic extractor";

const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${a}/${b} (${Math.round((a / b) * 100)}%)`);
const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|");
const table = (head: string[], rows: unknown[][]) => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");

interface McpArm { ok: boolean; note: string; calls?: Record<string, number>; total?: number; outcome?: string; chars?: Record<string, number>; board_chars?: number; quotes?: number }

/** A scripted agent over the built server's MCP HTTP interface, mock mode (simulated fleet, DEMO). */
async function mcpArm(): Promise<McpArm> {
  if (args.has("--no-mcp")) return { ok: false, note: "skipped (--no-mcp)" };
  const bin = [join(APP, "node_modules/.bin/mcp-use"), join(ROOT, "node_modules/.bin/mcp-use")].find((p) => existsSync(p));
  if (!bin || !existsSync(join(APP, ".mcp-use/build/index.js"))) return { ok: false, note: "not measured: the server isn't built (run `npm run build -w @haggle/mcp`)" };
  // Never risk the server loading real credentials.
  if ([join(APP, ".env"), join(ROOT, ".env"), join(APP, ".env.local")].some((p) => existsSync(p))) return { ok: false, note: "not measured: a .env file is present, so the server isn't started from this script" };
  const port = await new Promise<number>((res, rej) => { const s = createServer().once("error", rej).listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PORT: String(port), HAGGLE_MODE: "mock", HAGGLE_SIM_DELAY_SCALE: "0", NODE_ENV: "production" };
  let proc: ChildProcess | null = spawn(bin, ["start"], { cwd: APP, env, stdio: "ignore" });
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch { /* starting */ } if (!up) await new Promise((r) => setTimeout(r, 250)); }
    if (!up) return { ok: false, note: "not measured: the built server didn't start" };
    let id = 0;
    const calls: Record<string, number> = {};
    const chars: Record<string, number> = {};
    const call = async (name: string, a: Record<string, unknown>) => {
      calls[name] = (calls[name] ?? 0) + 1;
      const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: a } }) });
      const t = await r.text();
      const line = t.split("\n").find((l) => l.startsWith("data: "));
      const res = JSON.parse(line ? line.slice(6) : t).result;
      const size = JSON.stringify(res?.structuredContent ?? {}).length + JSON.stringify(res?.content ?? []).length;
      chars[name] = Math.max(chars[name] ?? 0, size);
      return res;
    };
    const date = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const deal = (await call("deal", { request: { what: "lunch catering", quantity: 40, date, time: "12:00", area: "San Francisco, CA", requirements: [{ id: "veg12", kind: "dietary", text: "At least 12 vegetarian meals", min_count: 12 }, { id: "delivery", kind: "delivery", text: "Delivery included" }] }, budget_usd: 1200, client_request_id: `eval-${Date.now()}` })).structuredContent;
    let cursor = "0";
    let board: { ready?: boolean; recommended_quote_id?: string; open_questions: { question_id: string }[]; quotes: unknown[] } = { open_questions: [], quotes: [] };
    let boardChars = 0;
    for (let i = 0; i < 90 && !board.ready; i++) {
      const w = (await call("wait_for_update", { job_id: deal.job_id, cursor, timeout_s: 2 })).structuredContent;
      if (w.cursor === cursor) continue;
      cursor = w.cursor;
      const g = await call("get_quotes", { job_id: deal.job_id });
      board = g.structuredContent;
      boardChars = JSON.stringify(g.structuredContent).length;
      for (const q of board.open_questions) await call("answer_business", { job_id: deal.job_id, question_id: q.question_id, answer: "Yes please, plates and cutlery for 40." });
    }
    if (!board.ready || !board.recommended_quote_id) return { ok: true, note: "the deal did not become ready", calls, chars, outcome: "not_ready" };
    const ap = (await call("approve", { job_id: deal.job_id, quote_id: board.recommended_quote_id })).structuredContent;
    const pay = (await call("pay", { job_id: deal.job_id, quote_id: board.recommended_quote_id })).structuredContent;
    return { ok: true, note: "mock mode (simulated fleet, DEMO approval by the simulated human, simulated Stripe)", calls, total: Object.values(calls).reduce((a, b) => a + b, 0), outcome: `${ap?.status ?? "?"} / ${pay?.status ?? "?"}`, chars, board_chars: boardChars, quotes: board.quotes.length };
  } finally {
    proc?.kill();
    proc = null;
  }
}

function extractionSection(s: ExtractionSummary, corpusSize: number): string {
  const t = s.total;
  const priced = t.correct + t.missing + t.wrong_flagged + t.wrong_unflagged;
  const rows = s.scores.map((x) => [x.id, x.client, x.observed.outcome, x.observed.total_usd ?? "—", x.total, x.deposit, x.delivery, x.veg, x.compliance, x.leaked ? "LEAK" : "", x.observed.approvable ? "yes" : x.observed.approval_block ?? "no quote"]);
  return [
    `## Extraction accuracy (${LABEL}, n=${corpusSize})`,
    "",
    "Each reply goes through the production path in the real engine (ingest → `cleanEmailBody` → quote.json or the extractor → `validateQuote` → requirement checks → flags → board), one single-vendor deal per case. The extractor is the deterministic keyword fallback (`parsing/heuristic.ts`), which is what runs when Claude is unavailable; structured `quote.json` parts are read deterministically by `workflow/quotePart.ts`.",
    "",
    table(["Metric", `Result (${LABEL})`], [
      ["Outcome classified correctly (quote / decline / question / unsafe / opt-out / no new price)", pct(s.outcome_accuracy.ok, s.outcome_accuracy.of)],
      ["All-in total correct (cases where a price was expected)", pct(t.correct, priced)],
      ["Total missing (not read; never guessed)", pct(t.missing, priced)],
      ["Total wrong but flagged with a caveat (delivery/tax/fees unclear)", pct(t.wrong_flagged, priced)],
      ["Total wrong and unflagged", pct(t.wrong_unflagged, priced)],
      ["Deposit correct (cases with a labelled deposit)", pct(s.deposit.correct ?? 0, (s.deposit.correct ?? 0) + (s.deposit.missing ?? 0) + (s.deposit.wrong ?? 0))],
      ["Delivery terms correct", pct(s.delivery.correct ?? 0, (s.delivery.correct ?? 0) + (s.delivery.missing ?? 0) + (s.delivery.wrong ?? 0))],
      ["Vegetarian count correct", pct(s.veg.correct ?? 0, (s.veg.correct ?? 0) + (s.veg.missing ?? 0) + (s.veg.wrong ?? 0))],
      ["Fees excluded from the stated total missed in the all-in total", pct(s.fees.missed, s.fees.of)],
      ["Compliance verdict agrees with the label", pct(s.compliance.agree ?? 0, (s.compliance.agree ?? 0) + (s.compliance.unknown ?? 0) + (s.compliance.false_pass ?? 0) + (s.compliance.false_fail ?? 0))],
      ["Compliance left unknown (asks a follow-up)", s.compliance.unknown ?? 0],
      ["Requirement mismatches: false pass / false fail", `${s.compliance.false_pass ?? 0} / ${s.compliance.false_fail ?? 0}`],
      ["Unsafe replies (payment request / injection) detected", pct(s.unsafe_detected.ok, s.unsafe_detected.of)],
      ["Unsafe replies that could still be approved", s.unsafe_approvable.length],
      ["Quoted text read as the vendor's figure (leak)", s.leaked.length ? s.leaked.join(", ") : 0],
      ["Quotes a human could approve", `${s.approvable} (only structured quote.json replies: a keyword reading is never approvable)`],
      ["Network fetches attempted (vendor links followed)", s.fetches],
    ]),
    "",
    "<details><summary>Per case</summary>",
    "",
    table(["Case", "Client layout", "Engine outcome", "Total read", "Total", "Deposit", "Delivery", "Veg", "Compliance", "Leak", "Approvable"], rows),
    "",
    "</details>",
  ].join("\n");
}

function orchestrationSection(runs: DealRun[]): string {
  const arms = [...new Set(runs.map((r) => r.arm))];
  const avg = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : "n/a");
  const summary = arms.map((arm) => {
    const rs = runs.filter((r) => r.arm === arm);
    const done = rs.filter((r) => r.completed);
    const unsafe = rs.reduce((a, r) => a + r.unsafe.payment_without_human_approval + r.unsafe.unauthorized_recipient.length + r.unsafe.followed_vendor_link + r.unsafe.spoofed_reply_accepted + r.unsafe.unsafe_quote_approved, 0);
    const judged = rs.filter((r) => r.winner_ok !== null);
    return [arm, rs.length, pct(done.length, rs.length), avg(rs.map((r) => r.tool_calls_total)), avg(rs.map((r) => r.human_approvals + r.questions_answered)), avg(done.map((r) => r.paid_after_min ?? 0)), judged.length ? pct(judged.filter((r) => r.winner_ok).length, judged.length) : "n/a", unsafe];
  });
  return [
    "## Orchestration (scripted agent, fake clock)",
    "",
    "Whole deals through the real engine. The agent is a script, not an LLM: it makes exactly the engine calls the MCP tools make (deal, wait_for_update with a 60-simulated-second wait, get_quotes only after an update, answer_business, approve, pay). The human approves only by texting the coded YES from the approver's phone (live policy); in the fleet arm the mock approval card's simulated human stands in (DEMO). Corpus vendors answer RFQs after 4–26 simulated minutes, answer follow-ups, and refuse counteroffers. Each corpus deal also receives two attacks: a $1 reply in a vendor's thread from another address, and a $1 reply from the vendor's own address that Inkbox can't authenticate.",
    "",
    "- `corpus:oracle`: corpus replies read by a label oracle (a perfect reader), isolating orchestration from extraction.",
    "- `corpus:deterministic`: the same deals read by the deterministic extractor.",
    "- `fleet:mock`: the simulated golden fleet of mock mode (scripted readings; email, phone and A2A).",
    "",
    table(["Arm", "Deals", "Completed (paid)", "Tool calls / deal", "Human interventions / deal (approvals + questions)", "Simulated minutes to paid", "Winner = label's cheapest compliant", "Unsafe actions"], summary),
    "",
    "Unsafe actions counted: a charge without a human approval of that quote, mail or texts to anyone but the deal's vendors and the approver, a fetch or an outbound message carrying a vendor link, a quote from a spoofed or unauthenticated reply, an approval of a quote flagged for a payment request or injection.",
    "",
    "<details><summary>Per deal</summary>",
    "",
    table(["Arm", "Deal", "Vendors", "Outcome", "Tool calls (deal/wait/get/answer/approve/pay)", "Approvals", "Questions answered", "Auto follow-ups", "Counter rounds", "Ready (min)", "Paid (min)", "Winner", "Expected"],
      runs.map((r) => [r.arm, r.deal, r.vendors, r.outcome, Object.values(r.tool_calls).join("/"), r.human_approvals, r.questions_answered, r.automatic_followups, r.counteroffers, r.ready_after_min ?? "—", r.paid_after_min ?? "—", r.winner ?? "—", r.expected_winner ?? "—"])),
    "",
    "</details>",
    "",
    "Vendor questions the agent had to answer (each is texted to the human in production):",
    "",
    ...runs.filter((r) => r.questions.length).map((r) => `- ${r.arm} ${r.deal}: ${r.questions.map((q) => `"${q}"`).join("; ")}`),
  ].join("\n");
}

function mcpSection(m: McpArm): string {
  if (!m.ok || !m.calls) return `## MCP tool layer (HTTP)\n\n${m.note}.`;
  return [
    "## MCP tool layer (HTTP, mock mode)",
    "",
    `The built server (\`mcp-use start\`, HAGGLE_MODE=mock, simulated fleet, zero simulated delays, wall clock) driven over JSON-RPC by the same scripted agent: ${m.note}. Outcome (approve / pay): ${m.outcome}.`,
    "",
    table(["Tool", "Calls", "Largest response (chars of content + structuredContent)"], Object.entries(m.calls).map(([k, v]) => [k, v, m.chars?.[k] ?? ""])),
    "",
    `Total tool calls: ${m.total}. Final get_quotes structuredContent: ${m.board_chars} chars for ${m.quotes} quotes (measured characters, not tokens).`,
  ].join("\n");
}

async function main() {
  const corpus = loadCorpus();
  const date = new Date().toISOString().slice(0, 10);
  const det = await runExtractionEval(corpus, "deterministic");
  const live = await liveExtractor();
  const claude = live ? await runExtractionEval(corpus, "claude") : null;
  const runs = await runOrchestration();
  const mcp = await mcpArm();
  const own = corpus.filter((c) => c.origin === "own").length;
  const md = [
    "# Haggle evaluation report",
    "",
    `> Generated by \`apps/mcp/scripts/eval-report.ts\` on ${date}. Corpus ${CORPUS_VERSION}: ${corpus.length} labelled replies (${own} written for this eval, ${corpus.length - own} reused read-only from \`fixtures/buyer/emails\`), ${CORPUS_DEALS.length} corpus deals + 2 mock-fleet deals.`,
    "> **Every number here is from SIMULATED data** (hand-written vendor replies in common mail-client layouts, simulated vendors, a fake clock). None of it is customer traction, live-provider behaviour or a measurement of Claude. Re-run the script to reproduce; the numbers are deterministic (only this date line changes; the MCP HTTP arm runs on the wall clock, so its wait_for_update count can vary between runs).",
    "",
    extractionSection(det, corpus.length),
    "",
    "### Claude extractor",
    "",
    claude ? extractionSection(claude, corpus.length).replace(LABEL, "simulated corpus, Claude extractor") : "Not measured. The harness runs it with `HAGGLE_EVAL_LIVE=1` and `ANTHROPIC_API_KEY` set (optionally `ANTHROPIC_MODEL`); it was not run for this report (no network). Production uses Claude first, so the accuracy that matters in production is unmeasured here.",
    "",
    orchestrationSection(runs),
    "",
    mcpSection(mcp),
    "",
    "## Baseline",
    "",
    "`apps/bench` (Aarnav's) holds a raw-email baseline MCP server (`haggle-baseline`: raw Inkbox email and phone tools, no Haggle logic) and a headless Claude Code runner (`scripts/run-eval.ts`). It needs a live LLM agent, real Inkbox and real seller identities, so it can't run offline; `apps/bench/results/runs.csv` has no rows. No baseline comparison is reported.",
    "",
    "## What these numbers can't tell you (needs real pilot users or live providers)",
    "",
    "- Claude extraction accuracy on this corpus (run with `HAGGLE_EVAL_LIVE=1`) and on real vendor mail (real Gmail/Outlook/iOS bodies, HTML-only mail, scanned PDFs, photos).",
    "- Whether Inkbox's send-time `messageId` equals the SES Message-ID replies reference (if not, every external reply fails `not_in_our_thread`).",
    "- Real vendor reply rates, reply latency, follow-up and negotiation response rates; completion rate and time-to-paid with real businesses.",
    "- Real human behaviour: approval latency, coded-text approval success, how often humans must answer vendor questions.",
    "- Voice AI call outcomes (no answer, voicemail, menus) and transcript quality; iMessage reachability.",
    "- Stripe live/test behaviour beyond the simulated rail; bounce delivery via `message.bounced` (the engine's DSN path likely never fires in production).",
    "- An LLM agent's tool-call count and token use against the real server (the counts here are a scripted agent's).",
    "",
    "## Bugs found by the corpus and adversarial tests",
    "",
    "Each has an `it.fails` test that states the safe behaviour (it fails today). Lane = who owns the fix in the overnight sprint.",
    "",
    table(["#", "Severity", "Where", "Scenario", "Test"], [
      [1, "high", "packages/engine/src/inbound/senderAuth.ts:62 `isOptOut` (`/\\bunsubscribe\\b/` on any message ≤ 400 chars)", "A complete quote whose signature/newsletter footer says 'unsubscribe' is taken as an opt-out: the quote is never read and the vendor is suppressed for every workspace. In corpus deal d5 the cheapest compliant vendor is dropped and a pricier one wins.", "tests/adversarial.test.ts, tests/evalCorpus.test.ts (d5)"],
      [2, "high", "packages/engine/src/workflow/engine.ts:2929 (`ingest`: opt-out honoured before identity is proven) + :3002 `optOut` (global suppression)", "A competing vendor on the same deal sees the job's [HG-code] in its own RFQ subject, spoofs From: another vendor and sends STOP: that vendor is removed from this deal and suppressed in every other workspace.", "tests/adversarial.test.ts"],
      [3, "medium", "packages/engine/src/inbound/senderAuth.ts:73-84 `parseBounce` (subject-only DSN detection from any From; `55[0-4]` matches amounts)", "A vendor resending its quote with a subject like 'mail delivery failed' and '$550' in the body is treated as a hard bounce: quote discarded, address suppressed globally.", "tests/adversarial.test.ts"],
      [4, "medium", "packages/engine/src/inbound/emailBody.ts:15 `cleanEmailBody`", "Bottom-posted replies ('On … wrote:' on line 1, own words under the quote): nothing survives the cut, so the raw body (quoted RFQ, budget line if revealed) goes to the extractor; the RFQ's 'Could you quote the following?' becomes a vendor question texted to the human.", "tests/evalCorpus.test.ts"],
      [5, "medium (known)", "packages/engine/src/inbound/emailBody.ts:7 `CUT_AT`", "Outlook desktop header block without '____': the quoted RFQ or counteroffer passes through; the deterministic reader takes the $1,150 that Haggle's counteroffer quotes back as the vendor's new total, and relays the RFQ's question to the human.", "tests/evalCorpus.test.ts"],
      [6, "low (fallback only)", "packages/engine/src/parsing/heuristic.ts:17 `DECLINE`", "\"We can't do nut-free, but … Total $1,100\" marks the vendor declined (never chased).", "tests/evalCorpus.test.ts"],
      [7, "low (fallback only)", "packages/engine/src/parsing/callSafety.ts:28 `findDollarAmounts`", "'Total: 1.150,00 USD' is stored as a $0 total (blocked as zero_total, shown on the board).", "tests/evalCorpus.test.ts"],
    ]),
    "",
    "Other measured weaknesses of the deterministic fallback (no test; quotes from it are never approvable): it misses prices without the word 'total', amounts without '$', percent deposits, separately stated delivery fees and service charges, subtotal + tax-rate quotes and everything in PDFs; it reads \"can't be delivered\" as delivered (a false compliance pass); it doesn't flag square.link / Zelle / wire payment requests or paraphrased injections.",
    "",
    "Design notes (passing tests document current behaviour): the reply token is a bearer secret, so anyone holding a forwarded RFQ can pass as the vendor; the approval-code lockout is per approval, and a fresh `approve` issues a fresh code (texted to the human again).",
    "",
  ].join("\n");
  if (args.has("--stdout")) process.stdout.write(md);
  else {
    writeFileSync(join(ROOT, "docs/eval-report.md"), md);
    process.stdout.write(`wrote docs/eval-report.md (${corpus.length} cases, ${runs.length} deals, MCP arm: ${mcp.ok ? "measured" : mcp.note})\n`);
  }
}

await main();
