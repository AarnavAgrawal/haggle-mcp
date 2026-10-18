#!/usr/bin/env node
// Natural-language journey check with a real Claude model against a Haggle MCP server.
//
//   node scripts/acceptance/nl-journey.mjs <server base URL> [env file] [--allow-deal] [--prompt "..."]
//
// Lists the server's tools and instructions over MCP, gives them to Claude (Anthropic Messages API)
// with the user's prompt, and runs the tool loop. Read-only tools are executed on the server.
// `deal` (outreach) is NOT executed unless --allow-deal is passed: by default it is recorded and the
// run stops there, so pointing this at a live server sends nothing. approve/pay/answer_business are
// never executed. Prints the trace and PASS/FAIL checks for the P0 journey. Never prints keys.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const base = args.find((a) => /^https?:\/\//.test(a));
const envFile = args.find((a) => a.endsWith(".env"));
const allowDeal = args.includes("--allow-deal");
const pi = args.indexOf("--prompt");
const PROMPT = pi >= 0 ? args[pi + 1] : "Use Haggle to help me plan a hackathon that I need to cater for that has 200 people next Saturday at the YC HQ in San Francisco. No preference for cuisine, budget under 5k.";
if (!base) throw new Error("usage: nl-journey.mjs <server base URL> [env file] [--allow-deal] [--prompt '...']");
const env = { ...process.env };
if (envFile) for (const l of readFileSync(envFile, "utf8").split("\n")) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m && !env[m[1]]) env[m[1]] = m[2]; }
const MODEL = env.NL_MODEL ?? env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";

// ── MCP over streamable HTTP ──
const url = base.replace(/\/$/, "") + "/mcp";
let sid = null, rid = 0;
async function rpc(method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: ++rid }), method, ...(params ? { params } : {}) }) });
  sid = r.headers.get("mcp-session-id") ?? sid;
  const t = await r.text();
  const line = t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).pop() ?? t;
  return line ? JSON.parse(line) : null;
}
const init = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "haggle-nl-journey", version: "1" } })).result;
await rpc("notifications/initialized");
// App-only tools (approve_in_view, mentions) are hidden from the model, as Claude.ai hides them.
const tools = (await rpc("tools/list")).result.tools.filter((t) => JSON.stringify(t._meta?.ui?.visibility ?? null) !== '["app"]');

// ── Claude ──
const today = new Date();
const system = [
  `Today is ${today.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} (${today.toISOString().slice(0, 10)}).`,
  "You are Claude in claude.ai with the Haggle connector enabled.",
  `Haggle server instructions: ${init.instructions ?? ""}`,
].join("\n");
const anthropicTools = tools.map((t) => ({ name: t.name.replace(/\./g, "_"), description: (t.description ?? "").slice(0, 1024), input_schema: t.inputSchema }));
const byApiName = Object.fromEntries(tools.map((t) => [t.name.replace(/\./g, "_"), t.name]));
const NEVER = new Set(["approve", "pay", "answer_business", "settings.update"]);

const messages = [{ role: "user", content: PROMPT }];
const trace = [];
for (let turn = 0; turn < 10; turn++) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", ...(env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": env.ANTHROPIC_WORKSPACE_ID } : {}) },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, system, tools: anthropicTools, messages }),
  });
  const msg = await res.json();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${JSON.stringify(msg).slice(0, 300)}`);
  messages.push({ role: "assistant", content: msg.content });
  const uses = msg.content.filter((c) => c.type === "tool_use");
  const said = msg.content.filter((c) => c.type === "text").map((c) => c.text).join(" ").trim();
  if (said) trace.push({ assistant: said.slice(0, 600) });
  if (!uses.length) break;
  const results = [];
  let stop = false;
  for (const u of uses) {
    const name = byApiName[u.name] ?? u.name;
    const step = { tool: name, input: u.input };
    trace.push(step);
    if (NEVER.has(name) || (name === "deal" && !allowDeal)) {
      step.executed = false;
      results.push({ type: "tool_result", tool_use_id: u.id, content: `[nl-journey dry run: ${name} not executed]` });
      stop = true;
      continue;
    }
    const r = (await rpc("tools/call", { name, arguments: u.input })).result;
    step.executed = true;
    step.isError = !!r?.isError;
    step.output = (r?.content?.[0]?.text ?? "").slice(0, 700);
    step.view = !!tools.find((t) => t.name === name)?._meta?.ui?.resourceUri;
    if (name === "deal") step.structured = { ok: r?.structuredContent?.ok, job_id: r?.structuredContent?.job_id, budget: r?.structuredContent?.request_details?.budget_usd, setup: r?.structuredContent?.setup };
    results.push({ type: "tool_result", tool_use_id: u.id, content: r?.content?.length ? r.content : [{ type: "text", text: JSON.stringify(r?.structuredContent ?? {}) }], ...(r?.isError ? { is_error: true } : {}) });
  }
  messages.push({ role: "user", content: results });
  if (stop) break;
}

// ── checks ──
const calls = trace.filter((s) => s.tool);
const firstDeal = calls.findIndex((s) => s.tool === "deal");
const deal = calls[firstDeal];
const nextSat = (() => { const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())); d.setUTCDate(d.getUTCDate() + ((((6 - d.getUTCDay()) + 7) % 7) || 7)); return d.toISOString().slice(0, 10); })();
const before = calls.slice(0, Math.max(firstDeal, 0)).map((s) => s.tool);
const checks = [
  ["calls deal", firstDeal >= 0],
  ["deal is the first purchase call (no ask/business_profile tour first)", firstDeal >= 0 && !before.some((t) => ["ask", "business_profile", "check_price"].includes(t))],
  ["quantity 200", deal?.input?.request?.quantity === 200],
  [`date = next Saturday (${nextSat})`, deal?.input?.request?.date === nextSat],
  ["budget_usd 5000 (the user's budget)", deal?.input?.budget_usd === 5000],
  ["no hand-picked unauthorized businesses", !(deal?.input?.businesses?.length)],
];
console.log(JSON.stringify({ server: init.serverInfo, model: MODEL, prompt: PROMPT, allowDeal, trace }, null, 1));
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
