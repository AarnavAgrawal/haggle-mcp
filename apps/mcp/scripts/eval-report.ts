// Generates docs/eval-report.md (WS-F) from the simulated evaluation corpus: extraction accuracy of the
// deterministic extractor, orchestration metrics with a scripted agent and a fake clock, and (when the
// server is built) tool calls and response sizes over the real MCP HTTP interface in mock mode.
// Every number is from SIMULATED data. Nothing here contacts a provider: the Claude extractor runs only
// with HAGGLE_EVAL_LIVE=1, ANTHROPIC_API_KEY and a HAGGLE_EVAL_MAX_USD dollar cap (it calls the
// Anthropic API; packages/engine/eval/liveBudget.ts enforces the cap; not run by default).
//
//   npx tsx apps/mcp/scripts/eval-report.ts            # writes docs/eval-report.md
//   npx tsx apps/mcp/scripts/eval-report.ts --stdout   # prints it instead
//   npx tsx apps/mcp/scripts/eval-report.ts --no-mcp   # skip the MCP HTTP arm
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { runBaseline, type BaselineRun } from "../../../packages/engine/eval/baseline.ts";
import { CORPUS_VERSION, loadCorpus, NEAR_DUPLICATES } from "../../../packages/engine/eval/corpus.ts";
import { liveExtractor, runExtractionEval, type ExtractionSummary } from "../../../packages/engine/eval/extraction.ts";
import { FIELDS, type Field } from "../../../packages/engine/eval/fields.ts";
import { CORPUS_DEALS, runOrchestration, type DealRun } from "../../../packages/engine/eval/orchestration.ts";
import type { CorpusCase } from "../../../packages/engine/eval/types.ts";

const ROOT = join(import.meta.dirname, "../../..");
const APP = join(ROOT, "apps/mcp");
const args = new Set(process.argv.slice(2));
const LABEL = "simulated corpus, deterministic extractor";
const FIELD_NAMES: Record<Field, string> = {
  identity: "Business identity (a reply naming another business is caught)", total: "All-in quoted total", tax: "Tax treatment", fees: "Fees (amount and whether included)", delivery: "Delivery terms",
  date: "Date / delivery time as requested", deposit: "Deposit", req_veg: "Hard requirement: at least 12 vegetarian", req_delivery: "Hard requirement: delivery included",
};
/** Fields the label oracle models (it is built from total, deposit, delivery and the vegetarian count only). */
const ORACLE_FIELDS = new Set<Field>(["total", "deposit", "delivery", "req_veg", "req_delivery"]);

const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${a}/${b} (${Math.round((a / b) * 100)}%)`);
const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|");
const table = (head: string[], rows: unknown[][]) => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");

interface McpArm { ok: boolean; note: string; calls?: Record<string, number>; total?: number; outcome?: string; chars?: Record<string, number>; board_chars?: number; board_text_chars?: number; detail_chars?: number; quotes?: number }

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
    let boardText = 0;
    for (let i = 0; i < 90 && !board.ready; i++) {
      const w = (await call("wait_for_update", { job_id: deal.job_id, cursor, timeout_s: 2 })).structuredContent;
      if (w.cursor === cursor) continue;
      cursor = w.cursor;
      const g = await call("get_quotes", { job_id: deal.job_id });
      board = g.structuredContent;
      boardChars = JSON.stringify(g.structuredContent).length;
      boardText = JSON.stringify(g.content ?? []).length;
      for (const q of board.open_questions) await call("answer_business", { job_id: deal.job_id, question_id: q.question_id, answer: "Yes please, plates and cutlery for 40." });
    }
    if (!board.ready || !board.recommended_quote_id) return { ok: true, note: "the deal did not become ready", calls, chars, outcome: "not_ready" };
    const compactChars = chars.get_quotes;
    const detail = JSON.stringify((await call("get_quotes", { job_id: deal.job_id, detail: true })).structuredContent).length;
    // The detail read is a measurement, not part of the agent's journey.
    calls.get_quotes = (calls.get_quotes ?? 1) - 1;
    if (compactChars !== undefined) chars.get_quotes = compactChars;
    const ap = (await call("approve", { job_id: deal.job_id, quote_id: board.recommended_quote_id })).structuredContent;
    const pay = (await call("pay", { job_id: deal.job_id, quote_id: board.recommended_quote_id })).structuredContent;
    return { ok: true, note: "mock mode (simulated fleet, DEMO approval by the simulated human, simulated Stripe)", calls, total: Object.values(calls).reduce((a, b) => a + b, 0), outcome: `${ap?.status ?? "?"} / ${pay?.status ?? "?"}`, chars, board_chars: boardChars, board_text_chars: boardText, detail_chars: detail, quotes: board.quotes.length };
  } finally {
    proc?.kill();
    proc = null;
  }
}

function fieldSection(s: ExtractionSummary, only?: Set<Field>): string {
  const f = s.fields;
  const rows = FIELDS.filter((k) => !only || only.has(k)).map((k) => { const x = f.fields[k]; return [FIELD_NAMES[k], x.of, pct(x.correct, x.of), x.missing, x.wrong]; });
  return [
    table(["Field", "Cases where the label defines it", `Correct (${s.extractor})`, "Missing (not read; never guessed)", "Wrong"], rows),
    "",
    `Money errors (a wrong dollar amount on the board, judged against the label; a missing amount is not one): **${f.money_errors_shown.count} shown** to the human${f.money_errors_shown.count ? ` (${f.money_errors_shown.cases.join(", ")})` : ""}; **${f.money_errors_approvable.count} approvable**${f.money_errors_approvable.count ? ` (${f.money_errors_approvable.cases.join(", ")})` : ""}.`,
  ].join("\n");
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
    `Extractor: **${s.extractor_label}**.`,
    "",
    "### Per field",
    "",
    fieldSection(s),
    "",
    "### Outcomes and safety",
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

function corpusSection(corpus: CorpusCase[]): string {
  const dups = Object.entries(NEAR_DUPLICATES);
  const f2 = corpus.filter((c) => c.tags.includes("f2"));
  return [
    "## Corpus review",
    "",
    `${corpus.length} labelled replies; **${corpus.length - dups.length} independently meaningful** for extraction, ${dups.length} near-duplicates in content (kept because each adds a mail-client layout or a delivery path the reader must survive):`,
    "",
    table(["Case", "Repeats", "What it adds"], dups.map(([id, d]) => [id, d.of, d.adds])),
    "",
    `Added in ${CORPUS_VERSION} (sprint 4) where real vendor mail had no case yet: ${f2.map((c) => `\`${c.id}\` (${c.description.replace(/\.$/, "")})`).join("; ")}.`,
  ].join("\n");
}

function journeySection(baseline: BaselineRun[], runs: DealRun[]): string {
  const avg = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : "n/a");
  type Row = { completed: boolean; correct: boolean; unsafe: boolean; interventions: number; calls: number; paid: number | null };
  const arm = (name: string, rs: Row[]) => {
    const done = rs.filter((r) => r.completed);
    return [name, rs.length, pct(done.length, rs.length), pct(rs.filter((r) => r.correct).length, rs.length), done.filter((r) => !r.correct).length, rs.filter((r) => r.unsafe).length, avg(rs.map((r) => r.interventions)), avg(rs.map((r) => r.calls)), avg(done.map((r) => r.paid ?? 0))];
  };
  const haggle = (kind: string): Row[] => runs.filter((r) => r.arm === kind).map((r) => ({ completed: r.completed, correct: r.completed && r.winner_ok === true, unsafe: r.unsafe.unsafe_quote_approved + r.unsafe.payment_without_human_approval > 0, interventions: r.human_approvals + r.questions_answered, calls: r.tool_calls_total, paid: r.paid_after_min }));
  const base: Row[] = baseline.map((r) => ({ completed: r.completed, correct: r.correct_purchase, unsafe: r.failures.some((f) => /instructions to the AI|outside the thread/.test(f)), interventions: r.human_interventions, calls: r.tool_calls_total, paid: r.paid_after_min }));
  return [
    "## Customer journey: Haggle vs a raw-email baseline (SIMULATED)",
    "",
    "Same six corpus deals, same simulated vendors and reply delays, same fake clock, same deterministic reader. The baseline (`packages/engine/eval/baseline.ts`) is a scripted agent with only an inbox: it writes the RFQs itself, polls once a simulated minute, strips quoted text as a mail client does, reads each reply with the keyword reader, relays vendor questions to the human, and after the same 30-minute window buys the cheapest total it read after one human OK. No compliance check, no follow-ups, no unsafe-reply screening. It is not sent the spoofed replies the Haggle runs receive (a raw inbox can't tell them apart, so its behaviour there would be a modelling choice). `corpus:oracle` is Haggle with a perfect reader: a ceiling, not a measurement of any reader.",
    "",
    table(["Arm", "Deals", "Completed (paid)", "Correct purchase (label's cheapest compliant, right all-in total)", "Wrong purchases", "Unsafe purchases", "Human interventions / deal", "Tool calls / deal", "Simulated minutes to paid"], [
      arm("baseline:raw-email (keyword reader)", base),
      arm("Haggle corpus:deterministic (keyword reader)", haggle("corpus:deterministic")),
      arm("Haggle corpus:oracle (perfect reader)", haggle("corpus:oracle")),
    ]),
    "",
    "Reading: with the same keyword reader, the baseline \"completes\" every deal by buying, and most of those purchases are wrong (a missed requirement, a total that leaves out a fee, a reply carrying instructions to the AI); Haggle completes none, because a keyword reading is never approvable, and buys nothing wrong. With a reader that gets the facts right, Haggle completes every deal correctly. Whether Claude is that reader on real mail is unmeasured (see Claude extractor).",
    "",
    "<details><summary>Baseline per deal</summary>",
    "",
    table(["Deal", "Bought from", "Paid", "Expected", "Failures"], baseline.map((r) => [r.deal, r.winner ?? "—", r.paid_usd ?? "—", r.expected_winner ?? "—", r.failures.join("; ") || "none"])),
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
    `Total tool calls: ${m.total}. Final get_quotes for ${m.quotes} quotes: structuredContent ${m.board_chars} chars (compact default), content text ${m.board_text_chars} chars; with \`detail: true\` ${m.detail_chars} chars. Measured characters, not tokens (roughly 4 characters per token for English JSON).`,
  ].join("\n");
}

async function main() {
  const corpus = loadCorpus();
  const date = new Date().toISOString().slice(0, 10);
  const det = await runExtractionEval(corpus, "deterministic");
  const oracle = await runExtractionEval(corpus, "oracle", {});
  const live = liveExtractor();
  const claude = live.ok ? await runExtractionEval(corpus, "claude") : null;
  const runs = await runOrchestration();
  const baseline = runBaseline(CORPUS_DEALS);
  const mcp = await mcpArm();
  const own = corpus.filter((c) => c.origin === "own").length;
  const md = [
    "# Haggle evaluation report",
    "",
    `> Generated by \`apps/mcp/scripts/eval-report.ts\` on ${date}. Corpus ${CORPUS_VERSION}: ${corpus.length} labelled replies (${own} written for this eval, ${corpus.length - own} reused read-only from \`fixtures/buyer/emails\`), ${CORPUS_DEALS.length} corpus deals + 2 mock-fleet deals.`,
    "> **Every number here is from SIMULATED data** (hand-written vendor replies in common mail-client layouts, simulated vendors, a fake clock). None of it is customer traction, live-provider behaviour or a measurement of Claude. Re-run the script to reproduce; the numbers are deterministic (only this date line changes; the MCP HTTP arm runs on the wall clock, so its wait_for_update count can vary between runs).",
    "",
    "## Live evidence",
    "",
    "**None yet.** No real vendor has been contacted, no real reply read, no real approval, booking or payment recorded, and the Claude extractor has not been run on this corpus. Every section below is simulated. Real pilot outcomes will come from `apps/mcp/scripts/traction.ts` (verified outcomes from the production database, excluding mock jobs, test workspaces/jobs and simulated vendors) and are to be reported separately from this file.",
    "",
    corpusSection(corpus),
    "",
    extractionSection(det, corpus.length),
    "",
    "### Scorer check: label oracle",
    "",
    `The same per-field scoring over a reader built from the labels (${oracle.extractor_label}). It must find no money error and every total right; fields the oracle doesn't model (identity, tax, fees, date) are left out. It measures nothing about a real reader.`,
    "",
    fieldSection(oracle, ORACLE_FIELDS),
    "",
    "### Claude extractor",
    "",
    claude ? extractionSection(claude, corpus.length).replace(LABEL, `simulated corpus, Claude extractor (${claude.live?.model}; spent about $${claude.live?.spent_usd} of a $${claude.live?.cap_usd} cap by the conservative price table)`) : `Not measured: ${live.ok ? "" : live.reason}. The harness runs it only with \`HAGGLE_EVAL_LIVE=1\`, \`ANTHROPIC_API_KEY\` and a dollar cap \`HAGGLE_EVAL_MAX_USD\` (optionally \`ANTHROPIC_MODEL\`, default claude-sonnet-5-5); every call is admitted against the cap first, using the conservative token count and price table documented in \`packages/engine/eval/liveBudget.ts\`. Production uses Claude first, so the accuracy that matters in production is unmeasured here.`,
    "",
    journeySection(baseline, runs),
    "",
    orchestrationSection(runs),
    "",
    mcpSection(mcp),
    "",
    "## LLM-driven baseline (apps/bench)",
    "",
    "`apps/bench` (Aarnav's) also holds an LLM-driven raw-email baseline MCP server and a headless Claude Code runner; it needs a live LLM agent, real Inkbox and real seller identities, so it can't run offline and `apps/bench/results/runs.csv` has no rows. The scripted baseline above is its offline stand-in.",
    "",
    "## What these numbers can't tell you (needs real pilot users or live providers)",
    "",
    "- Claude extraction accuracy on this corpus (run with `HAGGLE_EVAL_LIVE=1` and a `HAGGLE_EVAL_MAX_USD` cap) and on real vendor mail (real Gmail/Outlook/iOS bodies, HTML-only mail, scanned PDFs, photos).",
    "- Whether Inkbox's send-time `messageId` equals the SES Message-ID replies reference (if not, every external reply fails `not_in_our_thread`).",
    "- Real vendor reply rates, reply latency, follow-up and negotiation response rates; completion rate and time-to-paid with real businesses.",
    "- Real human behaviour: approval latency, coded-text approval success, how often humans must answer vendor questions.",
    "- Voice AI call outcomes (no answer, voicemail, menus) and transcript quality; iMessage reachability.",
    "- Stripe live/test behaviour beyond the simulated rail; bounce delivery via `message.bounced` (the engine's DSN path likely never fires in production).",
    "- An LLM agent's tool-call count and token use against the real server (the counts here are a scripted agent's).",
    "",
    "## Open findings (sprint 4, f2 corpus)",
    "",
    "Each has an `it.fails` test in `packages/engine/tests/evalFields.test.ts` stating the safe behaviour (it fails today).",
    "",
    table(["#", "Severity", "Where", "Scenario"], [
      [1, "high", "no offered-date field in `parsing/extraction.ts` QuoteExtraction; the request date is not a requirement", "\"Booked on the 29th, but we can do the 30th: Total $1,000\", read perfectly, is an approvable, recommended quote with no flag: the human can approve a booking for the wrong day. Same for a delivery window that misses the event time (c42)."],
      [2, "medium", "no check between the mailbox and the business the reply names", "A reply from a vendor's mailbox signed by another business (shared inbox, reseller, mistaken forward) is attributed to the contacted vendor and approvable without a caveat."],
      [3, "low (fallback only)", "`parsing/heuristic.ts` `amountNear`", "\"Total: $1,050 delivered, plus 8.625% sales tax\" is shown as a firm $1,050 with no tax caveat (never approvable)."],
      [4, "low (fallback only)", "`parsing/heuristic.ts`", "A 20% gratuity added on top is dropped: $1,000 is shown for a $1,200 order (never approvable)."],
    ]),
    "",
    "Fixed since the f1 report (their regression tests pass): a footer 'unsubscribe' read as an opt-out; a spoofed STOP suppressing a competitor; '$550' plus a bounce-like subject taken as a hard bounce; bottom-posted and Outlook header-block replies passing the quoted RFQ; \"can't do nut-free, but...\" marking the vendor declined; '1.150,00 USD' stored as $0.",
    "",
    "Other measured weaknesses of the deterministic fallback (no test; quotes from it are never approvable): it misses prices without the word 'total', amounts without '$', percent deposits, separately stated delivery fees and service charges, subtotal + tax-rate quotes and everything in PDFs; it reads \"can't be delivered\" as delivered (a false compliance pass); it doesn't flag square.link / Zelle / wire payment requests or paraphrased injections.",
    "",
    "Design notes (passing tests document current behaviour): the reply token is a bearer secret, so anyone holding a forwarded RFQ can pass as the vendor; the approval-code lockout is per approval, and a fresh `approve` issues a fresh code (texted to the human again).",
    "",
  ].join("\n");
  if (args.has("--stdout")) process.stdout.write(md);
  else {
    writeFileSync(join(ROOT, "docs/eval-report.md"), md);
    process.stdout.write(`wrote docs/eval-report.md (${corpus.length} cases, ${runs.length} deals + ${baseline.length} baseline deals, MCP arm: ${mcp.ok ? "measured" : mcp.note})\n`);
  }
}

await main();
