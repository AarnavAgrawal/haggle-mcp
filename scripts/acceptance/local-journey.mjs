#!/usr/bin/env node
// End-to-end local acceptance with REAL Claude against a LOCAL mock Haggle server (never a hosted one).
//
//   node scripts/acceptance/local-journey.mjs http://127.0.0.1:3712 apps/mcp/.env [--model claude-…]
//
// 1. Seeds an unrelated, older catering deal (200-person hackathon) directly over MCP.
// 2. Chat 1: real Claude (Anthropic Messages API with the server's own tools and instructions) gets the exact
//    one-sentence request; `deal` IS executed (mock server only: simulated vendors, nothing leaves the machine).
// 3. The simulated vendors reply: the script follows wait_for_update until quotes are final. Vendor questions
//    are answered by the script as the human user would ("yes, plates and cutlery"), labelled as such.
// 4. Chat 2: a FRESH Claude conversation asks "How's my catering order going? Which one should I pick?" with
//    no ids; it must find the new job (list_deals → get_quotes(job_id)) and never show the older deal.
// approve, pay, answer_business, call_back and settings.update are never executed for the model: approval and
// payment are human-only, so any attempt is recorded (and fails the "human-only" check).
// Prints the trace and PASS/FAIL per check. Never prints keys.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const base = args.find((a) => /^https?:\/\//.test(a));
const envFile = args.find((a) => a.endsWith(".env"));
const mi = args.indexOf("--model");
if (!base) throw new Error("usage: local-journey.mjs <local server URL> [env file] [--model id]");
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(base)) throw new Error("local-journey executes deal: it only runs against a local server (http://127.0.0.1:<port>)");
const env = { ...process.env };
if (envFile) for (const l of readFileSync(envFile, "utf8").split("\n")) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m && !env[m[1]]) env[m[1]] = m[2]; }
const MODEL = mi >= 0 ? args[mi + 1] : (env.NL_MODEL ?? env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5");
const PROMPT_1 = "I need catering for 50 people in San Francisco next Saturday. Find me the best deal.";
const PROMPT_2 = "How's my catering order going? Which one should I pick?";

// ── MCP over streamable HTTP ──
const url = base.replace(/\/$/, "") + "/mcp";
function mcp() {
  let sid = null, rid = 0;
  return async function rpc(method, params) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: ++rid }), method, ...(params ? { params } : {}) }) });
    sid = r.headers.get("mcp-session-id") ?? sid;
    const t = await r.text();
    const line = t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).pop() ?? t;
    return line ? JSON.parse(line) : null;
  };
}
const direct = mcp();
const callTool = async (rpc, name, a) => (await rpc("tools/call", { name, arguments: a })).result;
const health = await (await fetch(base.replace(/\/$/, "") + "/health")).json();
if (health.mode !== "mock") throw new Error(`server mode is ${health.mode}: local-journey needs HAGGLE_MODE=mock`);

const today = new Date();
const nextSat = (() => { const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())); d.setUTCDate(d.getUTCDate() + ((((6 - d.getUTCDay()) + 7) % 7) || 7)); return d.toISOString().slice(0, 10); })();

// ── 1. an unrelated older deal ──
const seeded = (await callTool(direct, "deal", { request: { what: "hackathon catering", quantity: 200, date: nextSat, area: "San Francisco, CA", venue: "YC HQ" }, budget_usd: 5000, client_request_id: `seed-${Date.now()}` })).structuredContent;
const OLD = seeded.job_id;
console.error(`seeded unrelated deal ${OLD}`);

// ── Claude with the server's tools ──
const NEVER = new Set(["approve", "pay", "answer_business", "call_back", "settings.update", "settings_update"]);
async function conversation(prompt, maxTurns) {
  const rpc = mcp();
  const init = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "haggle-local-journey", version: "1" } })).result;
  await rpc("notifications/initialized");
  const tools = (await rpc("tools/list")).result.tools.filter((t) => JSON.stringify(t._meta?.ui?.visibility ?? null) !== '["app"]');
  const system = [
    `Today is ${today.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} (${today.toISOString().slice(0, 10)}).`,
    "You are Claude in claude.ai with the Haggle connector enabled. This is a new conversation; you have no memory of earlier chats.",
    `Haggle server instructions: ${init.instructions ?? ""}`,
  ].join("\n");
  const anthropicTools = tools.map((t) => ({ name: t.name.replace(/\./g, "_"), description: (t.description ?? "").slice(0, 1024), input_schema: t.inputSchema }));
  const byApiName = Object.fromEntries(tools.map((t) => [t.name.replace(/\./g, "_"), t.name]));
  const messages = [{ role: "user", content: prompt }];
  const trace = [];
  let finalText = "";
  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", ...(env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": env.ANTHROPIC_WORKSPACE_ID } : {}) },
      body: JSON.stringify({ model: MODEL, max_tokens: 3000, system, tools: anthropicTools, messages }),
    });
    const msg = await res.json();
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${JSON.stringify(msg).slice(0, 300)}`);
    messages.push({ role: "assistant", content: msg.content });
    const uses = msg.content.filter((c) => c.type === "tool_use");
    const said = msg.content.filter((c) => c.type === "text").map((c) => c.text).join(" ").trim();
    if (said) { trace.push({ assistant: said }); finalText = said; }
    if (!uses.length) break;
    const results = [];
    for (const u of uses) {
      const name = byApiName[u.name] ?? u.name;
      const step = { tool: name, input: u.input };
      trace.push(step);
      if (NEVER.has(name)) {
        step.executed = false;
        results.push({ type: "tool_result", tool_use_id: u.id, content: `[local-journey: ${name} is human-only and was not executed. Ask the user.]`, is_error: true });
        continue;
      }
      const r = (await rpc("tools/call", { name, arguments: u.input })).result;
      step.executed = true;
      step.isError = !!r?.isError;
      step.output = (r?.content?.[0]?.text ?? "").slice(0, 500);
      step.structured = r?.structuredContent;
      results.push({ type: "tool_result", tool_use_id: u.id, content: r?.content?.length ? r.content : [{ type: "text", text: JSON.stringify(r?.structuredContent ?? {}) }], ...(r?.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }
  return { trace, finalText };
}

// ── 2. chat 1: the exact request ──
const c1 = await conversation(PROMPT_1, 12);
const dealStep = c1.trace.find((s) => s.tool === "deal" && s.executed && !s.isError && s.structured?.job_id);
const JOB = dealStep?.structured?.job_id ?? null;
console.error(`chat 1 started ${JOB ?? "no deal"}`);

// ── 3. vendors reply (the script drives the clock; the human answers vendor questions) ──
let board = null;
const humanAnswers = [];
if (JOB) {
  let cursor = "0";
  for (let i = 0; i < 60; i++) {
    cursor = (await callTool(direct, "wait_for_update", { job_id: JOB, cursor, timeout_s: 1 })).structuredContent.cursor;
    board = (await callTool(direct, "get_quotes", { job_id: JOB })).structuredContent;
    for (const q of board.open_questions) {
      const answer = "Yes, please include plates and cutlery for everyone."; // the user's answer, relayed by the script
      humanAnswers.push({ business: q.business ?? q.business_id, question: q.text, answer });
      await callTool(direct, "answer_business", { job_id: JOB, question_id: q.question_id, answer });
    }
    if (board.ready && !board.open_questions.length) break;
  }
}

// ── 4. chat 2: a fresh conversation, no ids ──
const c2 = await conversation(PROMPT_2, 10);

// ── checks ──
const d = dealStep?.input ?? {};
const req = d.request ?? {};
const c2calls = c2.trace.filter((s) => s.tool);
const allCalls = [...c1.trace, ...c2.trace].filter((s) => s.tool);
const mentionsJob = (s, id) => JSON.stringify(s.input ?? {}).includes(id);
const firstBoardForJob = c2calls.findIndex((s) => s.tool === "get_quotes" && mentionsJob(s, JOB ?? "∅"));
const rec = board?.quotes?.find((q) => q.quote_id === board.recommended_quote_id) ?? null;
const recTotal = rec ? `$${rec.total_usd.toLocaleString("en-US")}` : null;
const text2 = c2.finalText;
const checks = [
  ["chat 1: deal executed and created a NEW job (not the seeded one)", !!JOB && JOB !== OLD],
  ["chat 1: deal is the first purchase call (no ask/business_profile/check_price tour first)", (() => { const t = c1.trace.filter((s) => s.tool).map((s) => s.tool); const i = t.indexOf("deal"); return i >= 0 && !t.slice(0, i).some((x) => ["ask", "business_profile", "check_price"].includes(x)); })()],
  ["chat 1: quantity 50", req.quantity === 50],
  [`chat 1: date = next Saturday (${nextSat})`, req.date === nextSat],
  ["chat 1: no invented budget", d.budget_usd === undefined],
  ["chat 1: no invented time", req.time === undefined],
  ["chat 1: no invented requirements", !(req.requirements?.length) && !(d.requirements?.length)],
  ["chat 1: no hand-picked businesses", !(d.businesses?.length)],
  ["chat 1: the board returned is the new job's", dealStep?.structured?.job?.id === JOB],
  ["vendors: quotes present and final", !!board?.ready && (board?.quotes?.length ?? 0) >= 3],
  ["chat 2: found the deal without ids via list_deals (or get_quotes' job list) before opening it", firstBoardForJob > 0 && c2calls.slice(0, firstBoardForJob).some((s) => s.tool === "list_deals" || (s.tool === "get_quotes" && !s.input?.job_id))],
  ["chat 2: opened get_quotes(job_id) for the NEW job", firstBoardForJob >= 0],
  ["chat 2: never opened the unrelated older deal", !c2calls.some((s) => mentionsJob(s, OLD) && ["get_quotes", "wait_for_update"].includes(s.tool))],
  ["chat 2: answer names the recommended vendor", !!rec && text2.includes(rec.business)],
  ["chat 2: answer quotes the recommended total truthfully", !!recTotal && text2.includes(recTotal)],
  ["chat 2: answer doesn't present the 200-person deal as this order", !/\b200\b[^.\n]{0,40}(people|guests|attendees)/i.test(text2) || /\b50\b/.test(text2)],
  ["chat 2: doesn't claim anything was ordered, approved or paid", !text2.split(/(?<=[.!?\n])\s+/).some((s) => /\b(has been|have been|was|is now|I've|I have) (approved|paid|ordered|booked|confirmed)\b/i.test(s) && !/\b(nothing|not|no|n't|never|until|before|after|once)\b/i.test(s))],
  ["human-only: the model never attempted approve or pay", !allCalls.some((s) => s.tool === "approve" || s.tool === "pay")],
];
const info = {
  model: MODEL, seeded_old_job: OLD, new_job: JOB, recommended: rec && { business: rec.business, total_usd: rec.total_usd, deposit_usd: rec.deposit_usd ?? null, quote_id: rec.quote_id },
  payment_ceiling_usd: board?.payment_ceiling_usd, board_next: board?.next,
  model_answered_vendor_questions: allCalls.filter((s) => s.tool === "answer_business").map((s) => s.input),
  human_answers_by_script: humanAnswers,
  attempted_human_only: allCalls.filter((s) => NEVER.has(s.tool)).map((s) => ({ tool: s.tool, input: s.input })),
};
const slim = (t) => t.map((s) => (s.tool ? { tool: s.tool, input: s.input, executed: s.executed, isError: s.isError, output: s.output?.slice(0, 300) } : s));
console.log(JSON.stringify({ chat1: { prompt: PROMPT_1, trace: slim(c1.trace) }, chat2: { prompt: PROMPT_2, trace: slim(c2.trace) }, info }, null, 1));
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
console.log(`\n${checks.filter(([, ok]) => ok).length}/${checks.length} checks passed`);
process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
