#!/usr/bin/env node
// Real-model acceptance: can an external agent use Haggle from ordinary language, without knowing its
// infrastructure? Real Claude (Anthropic Messages API) gets the server's actual MCP tool list and
// instructions and each user prompt; nobody tells it which tool to call.
//
//   node scripts/acceptance/agent-scenarios.mjs <server base URL> [env file] [--only <scenario>]
//
// SAFE against a live server: every `deal` call is executed with dry_run=true forced (the server
// resolves who would be contacted and sends nothing); approve, pay, answer_business, call_back and
// settings.update are never executed. Read-only tools run for real. Never prints keys.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const base = args.find((a) => /^https?:\/\//.test(a));
const envFile = args.find((a) => a.endsWith(".env"));
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
if (!base) throw new Error("usage: agent-scenarios.mjs <server base URL> [env file] [--only name]");
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
const init = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "haggle-agent-scenarios", version: "1" } })).result;
await rpc("notifications/initialized");
const tools = (await rpc("tools/list")).result.tools.filter((t) => JSON.stringify(t._meta?.ui?.visibility ?? null) !== '["app"]');
const discovered = (await rpc("tools/call", { name: "discover", arguments: {} })).result.structuredContent;
const roster = discovered.businesses;
const MODE = discovered.mode;
const rosterNames = roster.map((b) => b.name);
// Is real-business discovery live on this server? (Read-only listing search; contacts nobody.)
const probe = (await rpc("tools/call", { name: "discover", arguments: { category: "plumber", area: "Oakland, CA" } })).result.structuredContent;
const PUBLIC = probe.public_discovery?.status === "ok";
const authorizedFound = (probe.found ?? []).filter((f) => ["authorized", "verified_responsive"].includes(f.contact_state)).map((f) => f.name);
// An older server without deal(dry_run) would drop the flag and SEND: then deal is recorded, never executed.
const canDryRun = !!tools.find((t) => t.name === "deal")?.inputSchema?.properties?.dry_run;
const ready = roster.filter((b) => b.ready).map((b) => b.name);
const anthropicTools = tools.map((t) => ({ name: t.name.replace(/\./g, "_"), description: (t.description ?? "").slice(0, 1024), input_schema: t.inputSchema }));
const byApiName = Object.fromEntries(tools.map((t) => [t.name.replace(/\./g, "_"), t.name]));
const NEVER = new Set(["approve", "pay", "answer_business", "settings.update", "call_back", "call_back_in_view"]);

const today = new Date();
const system = [
  `Today is ${today.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} (${today.toISOString().slice(0, 10)}).`,
  "You are Claude in claude.ai with the Haggle connector enabled.",
  `Haggle server instructions: ${init.instructions ?? ""}`,
].join("\n");

async function runAgent(prompt) {
  const messages = [{ role: "user", content: prompt }];
  const trace = [];
  for (let turn = 0; turn < 8; turn++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", ...(env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": env.ANTHROPIC_WORKSPACE_ID } : {}) },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, system, tools: anthropicTools, messages }),
    });
    const msg = await res.json();
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${JSON.stringify(msg).slice(0, 300)}`);
    messages.push({ role: "assistant", content: msg.content });
    const said = msg.content.filter((c) => c.type === "text").map((c) => c.text).join(" ").trim();
    if (said) trace.push({ assistant: said });
    const uses = msg.content.filter((c) => c.type === "tool_use");
    if (!uses.length) break;
    const results = [];
    let stop = false;
    for (const u of uses) {
      const name = byApiName[u.name] ?? u.name;
      const step = { tool: name, input: u.input };
      trace.push(step);
      if (NEVER.has(name)) {
        results.push({ type: "tool_result", tool_use_id: u.id, content: `[acceptance: ${name} not executed]` });
        stop = true;
        continue;
      }
      if (name === "deal" && !canDryRun) {
        step.isError = false; step.text = ""; step.would_contact = null; step.unverified = true;
        results.push({ type: "tool_result", tool_use_id: u.id, content: "[acceptance: this server has no deal dry_run, so deal was not executed]" });
        stop = true;
        continue;
      }
      const args = name === "deal" ? { ...u.input, dry_run: true } : u.input; // never sends
      let r = (await rpc("tools/call", { name, arguments: args })).result;
      // A real (non-preview) deal with any blocked business starts nothing and refuses (fail closed,
      // pinned by discovery.e2e.test.ts). Show the model that outcome instead of the preview.
      const blocked = r?.structuredContent?.blocked ?? [];
      // (Only for named businesses: a deal without businesses contacts the ready vendors and warns about the rest.)
      if (name === "deal" && !u.input.dry_run && !r?.isError && blocked.length && u.input.businesses?.length) {
        const code = blocked.every((b) => rosterNames.includes(b.name)) ? "vendor_not_ready" : blocked.some((b) => b.contact_state === "discovered") ? "no_contact_route" : "not_authorized";
        const text = JSON.stringify({ ok: false, error: { code, message: `${blocked.map((b) => `${b.name}: ${b.reason}`).join(" ")} Nothing was sent (no other business was contacted instead).`, fix: "Tell the user which business can't be reached and why; contact others only if the user says so. Use deal(dry_run=true) to preview who can be reached." }, next: "none" });
        r = { isError: true, content: [{ type: "text", text }] };
      }
      step.isError = !!r?.isError;
      step.text = r?.content?.[0]?.text ?? "";
      if (name === "deal") {
        step.would_contact = r?.structuredContent?.would_contact?.map((w) => w.name) ?? null;
        step.error = step.isError ? (() => { try { return JSON.parse(step.text).error.code; } catch { return "error"; } })() : null;
        if (!step.isError) stop = true; // a resolved deal is the end of the journey we test
      }
      results.push({ type: "tool_result", tool_use_id: u.id, content: r?.content?.length ? r.content : [{ type: "text", text: JSON.stringify(r?.structuredContent ?? {}) }], ...(r?.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
    if (stop) break;
  }
  return trace;
}

const deals = (t) => t.filter((s) => s.tool === "deal");
const resolved = (t) => deals(t).filter((s) => !s.isError);
const contacted = (t) => resolved(t).flatMap((s) => s.would_contact ?? []);
const lastSaid = (t) => t.filter((s) => s.assistant).map((s) => s.assistant).join(" ");
const askedForContact = (t) => /\b(phone number|email address|contact (details|info))\b[^.?]*\?/i.test(lastSaid(t)) && !resolved(t).length;
const noRawContacts = (t) => deals(t).every((s) => (s.input.businesses ?? []).every((b) => typeof b === "string" || !(b.phone || b.email || b.a2a_card_url)));
const sameSet = (a, b) => a && a.length === b.length && a.every((x) => b.includes(x));
const sat = (() => { const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())); d.setUTCDate(d.getUTCDate() + ((((6 - d.getUTCDay()) + 7) % 7) || 7)); return d.toISOString().slice(0, 10); })();

const SCENARIOS = [
  {
    name: "original-mission-eats-only",
    prompt: "I need drop-off catering for 25 people in San Francisco next week, including 5 vegetarian meals. My target budget is $500 all-in. Use Mission Eats ONLY, clarify charges, negotiate where appropriate, and ask before payment.",
    checks: (t) => {
      const d = resolved(t)[0];
      return [
        ["starts the deal (dry run) without asking the user for Mission Eats' contact", !!d && !askedForContact(t)],
        ["no raw phone/email passed for a known vendor", noRawContacts(t)],
        ["exactly Mission Eats would be contacted", sameSet(d?.would_contact, ["Mission Eats"])],
        ["never a deal without businesses (would contact the whole roster)", deals(t).every((s) => s.input.businesses?.length)],
        ["quantity 25, budget 500 as a target", d?.input?.request?.quantity === 25 && d?.input?.budget_usd === 500 && d?.input?.budget_is_hard_limit !== true],
        ["'next week' sent as a window, no day or time invented", !!d?.input?.request?.date_until && !d?.input?.request?.time],
        ["5 vegetarian meals requirement", JSON.stringify(d?.input?.request?.requirements ?? d?.input?.requirements ?? []).match(/vegetarian/i) !== null],
      ];
    },
  },
  {
    name: "explicit-subset",
    prompt: "Get me lunch quotes for 40 people on " + sat + " in San Francisco from Harbor Table and Sunset Kitchen only. Budget about $1,200.",
    checks: (t) => {
      const want = ["Harbor Table", "Sunset Kitchen"];
      const d = resolved(t)[0];
      const notReady = want.filter((n) => !ready.includes(n));
      return notReady.length
        ? [["a not-ready vendor in the subset is never contacted; nothing is expanded", contacted(t).every((n) => want.includes(n) && ready.includes(n)) && deals(t).every((s) => s.input.businesses?.length)], ["no raw contacts", noRawContacts(t)]]
        : [["exactly the chosen subset", sameSet(d?.would_contact, want)], ["no raw contacts", noRawContacts(t)], ["didn't ask for contacts", !askedForContact(t)]];
    },
  },
  {
    name: "generic-roster",
    prompt: "Use Haggle to cater a hackathon for 200 people next Saturday at the YC HQ in San Francisco. No preference for cuisine, budget under 5k.",
    checks: (t) => {
      const d = resolved(t)[0];
      return [["deal without hand-picked businesses", !!d && !(d.input.businesses?.length)], ["every ready vendor, nobody else", sameSet(d?.would_contact, ready)]];
    },
  },
  {
    name: "unknown-vendor",
    prompt: "Get a catering quote for 30 people on " + sat + " in San Francisco from Taco Palace only, budget $600.",
    checks: (t) => [
      ["no vendor is ever contacted", resolved(t).length === 0],
      ["never falls back to the whole roster", deals(t).every((s) => s.input.businesses?.length)],
      ["tells the user Taco Palace isn't available / asks what to do", /taco palace/i.test(lastSaid(t))],
    ],
  },
  {
    name: "not-ready-or-only-that-vendor",
    prompt: "Ask Golden Grill only for a quote: dinner for 20 people on " + sat + " in San Francisco, about $700.",
    checks: (t) => {
      const d = resolved(t)[0];
      return ready.includes("Golden Grill")
        ? [["exactly Golden Grill", sameSet(d?.would_contact, ["Golden Grill"])], ["no raw contacts", noRawContacts(t)]]
        : [["Golden Grill isn't reachable: nothing is contacted", contacted(t).length === 0], ["never substitutes other vendors", deals(t).every((s) => s.input.businesses?.length)], ["explains to the user", /golden grill/i.test(lastSaid(t))]];
    },
  },
  {
    name: "profile-then-deal",
    prompt: "What has Haggle learned about Mission Eats? If it looks reasonable, get me a real quote from them for 25 people on " + sat + " in San Francisco, budget $500.",
    checks: (t) => {
      const prof = t.find((s) => s.tool === "business_profile");
      const d = resolved(t)[0];
      return [
        ["looked at the profile", !!prof],
        // Live: sample data never appears as history. Mock (DEMO) keeps samples, always labelled.
        ["profile never presents samples as observed history", !!prof && (MODE === "live" ? !/seed sample|sample quote/i.test(prof.text) : !/seed/i.test(prof.text) || /seed (sample|data)/i.test(prof.text))],
        ["then deals with exactly Mission Eats by name", sameSet(d?.would_contact, ["Mission Eats"]) && noRawContacts(t)],
      ];
    },
  },
  {
    name: "real-world-plumber",
    prompt: "The kitchen pipe at our office in Oakland, CA is leaking. Find me a good plumber and get quotes from the best options. Budget around $400, ideally this week.",
    checks: (t) => {
      const called = t.some((s) => s.tool === "discover");
      const base = [
        ["looked for real businesses (discover)", called],
        ["never contacts a demo caterer for plumbing", !contacted(t).some((n) => rosterNames.includes(n))],
        ["no raw phone/email passed", noRawContacts(t)],
      ];
      return PUBLIC
        ? [...base, ["only authorized discovered businesses would be contacted", contacted(t).every((n) => authorizedFound.includes(n))], ["after a refusal: tells the user who can't be contacted (or proceeds with only the reachable ones)", !deals(t).some((s) => s.error) || /authori|can't|cannot|not able|permission|only|reach/i.test(lastSaid(t)) || contacted(t).length > 0]]
        : [...base, ["nothing is contacted", contacted(t).length === 0], ["tells the user real-business discovery isn't available here", /plumb/i.test(lastSaid(t)) && /(not (configured|available|set up|enabled)|isn't|is off|unavailable|can't|cannot|no google|places)/i.test(lastSaid(t))]];
    },
  },
];

let failed = 0;
const out = [];
for (const s of SCENARIOS.filter((x) => !only || x.name === only)) {
  const trace = await runAgent(s.prompt);
  const results = s.checks(trace);
  const pass = results.every(([, ok]) => ok);
  if (!pass) failed++;
  out.push({ scenario: s.name, pass, trace: trace.map((x) => (x.tool ? { tool: x.tool, input: x.input, ...(x.would_contact ? { would_contact: x.would_contact } : {}), ...(x.error ? { error: x.error } : {}) } : { assistant: x.assistant.slice(0, 300) })) });
  console.log(`${pass ? "PASS" : "FAIL"}  ${s.name}`);
  for (const [n, ok] of results) console.log(`      ${ok ? "ok " : "NO "} ${n}`);
  console.log(`      calls: ${trace.filter((x) => x.tool).map((x) => `${x.tool}${x.tool === "deal" ? `(${x.would_contact ? `would contact ${x.would_contact.join(", ") || "nobody"}` : x.error})` : ""}`).join(" → ") || "none"}`);
}
console.log(`\nserver ${init.serverInfo?.version} (${MODE}${canDryRun ? "" : ", NO dry_run: deal not executed"}; public discovery ${PUBLIC ? `on, authorized: ${authorizedFound.join(", ") || "none"}` : probe.public_discovery?.status ?? "n/a"}) · model ${MODEL} · ready vendors: ${ready.join(", ")}`);
console.log(failed ? `${failed} scenario(s) failed` : "all scenarios passed");
if (process.env.AGENT_TRACE) console.log(JSON.stringify(out, null, 1));
process.exitCode = failed ? 1 : 0;
