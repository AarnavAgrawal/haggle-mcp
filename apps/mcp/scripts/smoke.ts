// Post-deploy smoke test against a running server: /health, /ready, MCP initialize + tools/list,
// and (mock servers only) one simulated deal through the tools until a quote lands. Never runs a
// deal on a live server: it checks the server's own mode first, twice. Prints no secrets.
//
//   node apps/mcp/scripts/smoke.ts <base url> [--token <workspace bearer>] [--expect-build <sha>] [--no-deal]
//   node apps/mcp/scripts/smoke.ts <base url> --live-readonly [--token ...] [--expect-build <sha>]
//   (or HAGGLE_SMOKE_TOKEN in the environment). Exit 0 = every check passed.
//
// --live-readonly (production-safe): /health, /ready, initialize, tools/list and only the tools in
// READONLY_TOOLS, each called only if the server itself annotates it readOnlyHint=true and
// openWorldHint=false. A tool that can send, call, text, advance a deal or pay is refused before any
// request is made (assertReadOnlyCall), whatever the server says.
//
// Manufact intercepts /health on its hosted servers (the platform answers it), so a non-Haggle
// /health response is reported as skipped there; /ready and the MCP checks still run.

export interface SmokeOptions { base: string; token?: string; expectBuild?: string; deal: boolean; readonly?: boolean; fetch?: typeof fetch; log?: (line: string) => void; dealTimeoutMs?: number }
export interface SmokeResult { ok: boolean; checks: { name: string; status: "pass" | "fail" | "skip"; detail: string }[] }

const CORE_TOOLS = ["deal", "wait_for_update", "get_quotes", "approve", "pay", "list_deals", "open_haggle"];
/** The only tools --live-readonly calls: they read the database and contact nobody. */
export const READONLY_TOOLS: Record<string, Record<string, unknown>> = { list_deals: { limit: 1 }, get_identity: {} };
/**
 * Never called by --live-readonly, even if a server annotated them read-only: they send, call, text,
 * pay or change a deal, advance deals as a side effect of reading (wait_for_update, get_quotes,
 * open_haggle, get_conversation run the engine's advance), or reach public providers.
 */
export const SENDS_OR_PAYS = new Set(["deal", "pay", "approve", "answer_business", "send_message", "negotiate", "cancel_deal", "call_back", "call_back_in_view", "approve_in_view", "choose_in_view", "wait_for_update", "get_quotes", "open_haggle", "get_conversation", "discover", "business_profile", "ask", "check_price"]);

/** Everything the mock-server deal may call: never approve, pay, send_message, call_back or negotiate. */
export const MOCK_DEAL_TOOLS = new Set(["list_deals", "deal", "wait_for_update", "get_quotes", "cancel_deal"]);

export interface ToolMeta { name: string; annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean; destructiveHint?: boolean } }
/** Throws unless `name` is allowlisted, not a sending/paying tool, and the server annotates it read-only and closed-world. */
export function assertReadOnlyCall(name: string, tools: ToolMeta[]): void {
  if (SENDS_OR_PAYS.has(name) || !Object.hasOwn(READONLY_TOOLS, name)) throw new Error(`refused: ${name} is not a read-only smoke tool`);
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`refused: ${name} is not listed by the server`);
  if (t.annotations?.readOnlyHint !== true || t.annotations?.openWorldHint !== false || t.annotations?.destructiveHint === true) throw new Error(`refused: the server does not annotate ${name} as read-only and closed-world`);
}

export function parseSmokeArgs(argv: string[], env: Record<string, string | undefined> = process.env): SmokeOptions {
  const base = argv.find((a, i) => !a.startsWith("--") && !["--token", "--expect-build"].includes(argv[i - 1] ?? ""));
  if (!base || !/^https?:\/\/[^\s/]+/.test(base)) throw new Error("usage: smoke.ts <base url, e.g. http://127.0.0.1:3000> [--token <bearer>] [--expect-build <sha>] [--no-deal | --live-readonly]");
  const readonly = argv.includes("--live-readonly");
  const val = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const token = val("token") ?? env.HAGGLE_SMOKE_TOKEN?.trim();
  const expectBuild = val("expect-build");
  return { base: base.replace(/\/+$/, "").replace(/\/mcp$/, ""), ...(token ? { token } : {}), ...(expectBuild ? { expectBuild } : {}), deal: !readonly && !argv.includes("--no-deal"), ...(readonly ? { readonly } : {}) };
}

/** The server's build label: build_sha (0.6.0 servers since sprint 5), else the older `build` field. */
const buildOf = (j: Record<string, unknown> | null | undefined): string => (typeof j?.build_sha === "string" ? j.build_sha : typeof j?.build === "string" ? j.build : "unknown");

export async function runSmoke(o: SmokeOptions): Promise<SmokeResult> {
  const f = o.fetch ?? fetch;
  const out: SmokeResult["checks"] = [];
  const check = (name: string, status: "pass" | "fail" | "skip", detail = "") => { out.push({ name, status, detail }); o.log?.(`${status.toUpperCase().padEnd(4)}  ${name}${detail ? ` - ${detail}` : ""}`); };
  const auth: Record<string, string> = o.token ? { authorization: `Bearer ${o.token}` } : {};
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await f(`${o.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...auth }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    const msg = JSON.parse(line ? line.slice(6) : text) as { result?: Record<string, unknown>; error?: { message?: string } };
    if (msg.error) throw new Error(`${method}: ${msg.error.message ?? "error"}`);
    return msg.result as Record<string, unknown>;
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    // Defence in depth: in --live-readonly nothing outside the allowlist reaches the server.
    if (o.readonly && (SENDS_OR_PAYS.has(name) || !Object.hasOwn(READONLY_TOOLS, name))) throw new Error(`refused: ${name} in --live-readonly`);
    // The mock deal never approves or pays, even on a mock server.
    if (!o.readonly && !MOCK_DEAL_TOOLS.has(name)) throw new Error(`refused: ${name} is not a smoke tool`);
    return callTool(name, args);
  };
  const callTool = async (name: string, args: Record<string, unknown>) => (await rpc("tools/call", { name, arguments: args })) as { isError?: boolean; content?: { text?: string }[]; structuredContent?: Record<string, unknown> };
  const getJson = async (path: string) => {
    const res = await f(`${o.base}${path}`, { signal: AbortSignal.timeout(15_000) });
    const body = await res.text();
    try { return { status: res.status, json: JSON.parse(body) as Record<string, unknown> }; } catch { return { status: res.status, json: null }; }
  };

  let mode: string | null = null;
  try {
    const h = await getJson("/health");
    if (h.json?.service !== "haggle-mcp") check("/health", "skip", `not Haggle's JSON (HTTP ${h.status}; hosted platforms answer /health themselves)`);
    else {
      mode = typeof h.json.mode === "string" ? h.json.mode : null;
      check("/health", h.status === 200 && h.json.ok === true ? "pass" : "fail", `HTTP ${h.status}, mode ${mode ?? "?"}, version ${h.json.version ?? "?"}, build ${buildOf(h.json)}`);
    }
  } catch (e) { check("/health", "fail", (e as Error).message); }

  try {
    const r = await getJson("/ready");
    const checks = (r.json?.checks ?? {}) as Record<string, { ok?: boolean }>;
    const failing = Object.entries(checks).filter(([, c]) => !c.ok).map(([k]) => k);
    mode ??= typeof r.json?.mode === "string" ? r.json.mode : null;
    check("/ready", r.status === 200 && r.json?.ready === true ? "pass" : "fail", r.json ? `HTTP ${r.status}${failing.length ? `, failing: ${failing.join(", ")}` : ""}` : `HTTP ${r.status}, not JSON`);
    if (o.expectBuild) { const b = buildOf(r.json); check("build matches", b !== "unknown" && b !== "invalid" && b.startsWith(o.expectBuild) ? "pass" : "fail", `server ${b}, expected ${o.expectBuild}`); }
  } catch (e) { check("/ready", "fail", (e as Error).message); }

  try {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "haggle-smoke", version: "1" } });
    const info = init.serverInfo as { name?: string; version?: string } | undefined;
    check("MCP initialize", info?.name === "haggle" ? "pass" : "fail", `server ${info?.name ?? "?"} ${info?.version ?? ""}`.trim());
    const { tools } = (await rpc("tools/list")) as { tools: ToolMeta[] };
    const names = new Set(tools.map((t) => t.name));
    const missing = CORE_TOOLS.filter((t) => !names.has(t));
    check("MCP tools/list", missing.length ? "fail" : "pass", missing.length ? `missing ${missing.join(", ")}` : `${tools.length} tools`);
    if (o.readonly) {
      for (const [name, args] of Object.entries(READONLY_TOOLS)) {
        try {
          assertReadOnlyCall(name, tools);
          const r = await call(name, args);
          const m = r.structuredContent?.mode;
          check(`read-only ${name}`, r.isError ? "fail" : "pass", r.isError ? "tool error" : `mode ${typeof m === "string" ? m : "?"}`);
        } catch (e) { check(`read-only ${name}`, "fail", (e as Error).message); }
      }
    }
  } catch (e) { check("MCP initialize + tools/list", "fail", (e as Error).message); }

  if (o.readonly) check("mock deal", "skip", "--live-readonly");
  else if (!o.deal) check("mock deal", "skip", "--no-deal");
  else if (mode !== "mock") check("mock deal", "skip", `server mode is ${mode ?? "unknown"}; deals run only against mock servers`);
  else {
    try {
      // Second check, from the tool's own envelope: a live server answers mode "live" here.
      const deals = await call("list_deals", { limit: 1 });
      if (deals.structuredContent?.mode !== "mock") throw new Error(`list_deals reports mode ${String(deals.structuredContent?.mode)}; refusing to start a deal`);
      const date = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
      const d = await call("deal", { request: { what: "lunch catering", quantity: 20, unit: "people", date, area: "San Francisco, CA", requirements: [] }, budget_usd: 800, client_request_id: `smoke-${Date.now()}` });
      const jobId = d.structuredContent?.job_id as string | undefined;
      if (d.isError || !jobId) throw new Error(`deal failed: ${(d.content?.[0]?.text ?? "").slice(0, 200)}`);
      if (d.structuredContent?.mode !== "mock") throw new Error("deal did not run in mock mode");
      let cursor = "0";
      let quotes = 0;
      const until = Date.now() + (o.dealTimeoutMs ?? 60_000);
      while (Date.now() < until && quotes === 0) {
        const w = await call("wait_for_update", { job_id: jobId, cursor, timeout_s: 2 });
        cursor = String(w.structuredContent?.cursor ?? cursor);
        quotes = ((await call("get_quotes", { job_id: jobId })).structuredContent?.quotes as unknown[] | undefined)?.length ?? 0;
      }
      check("mock deal", quotes > 0 ? "pass" : "fail", `${jobId}: ${quotes} quote(s)`);
      await call("cancel_deal", { job_id: jobId }).catch(() => undefined);
    } catch (e) { check("mock deal", "fail", (e as Error).message); }
  }
  return { ok: out.every((c) => c.status !== "fail"), checks: out };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/smoke.ts")) {
  (async () => {
    const opts = parseSmokeArgs(process.argv.slice(2));
    const r = await runSmoke({ ...opts, log: (l) => console.log(l) });
    console.log(r.ok ? "smoke OK" : "smoke FAILED");
    process.exit(r.ok ? 0 : 1);
  })().catch((e) => {
    console.error(`smoke failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
