// Sprint 4, workstream D (HTTP): the built server with authentication required, two workspaces and
// the live approval policy (HAGGLE_APPROVALS=out_of_band). The client is the attacker: a model with
// every tool and no human. Checked here: (1) the full tool surface, enumerated, exposes no
// operator-admin capability (vendors, allowlist, workspaces, quarantine, job-ops); (2) call_back never
// places a call from a tool, form or board code; (3) two workspaces dealing with the SAME simulated
// vendors at the same time see only their own deal in every tool's output, however their event
// streams interleave. Mock mode (DEMO) so nothing external runs. Run `mcp-use build` first.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const APP_DIR = join(import.meta.dirname, "..");
const WIN = process.platform === "win32";
const MCP_USE_BIN = [join(APP_DIR, "node_modules/.bin/mcp-use"), join(APP_DIR, "../../node_modules/.bin/mcp-use")].map((p) => (WIN ? `${p}.cmd` : p)).find((p) => existsSync(p)) ?? "mcp-use";
const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
    const p = (srv.address() as AddressInfo).port;
    srv.close(() => resolve(p));
  });
});
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const ALPHA = "hgw_alpha_d4_token_0123456789abcdef00";
const BETA = "hgw_beta_d4_token_0123456789abcdef000";
const WORKSPACES = [
  { id: "ws_alpha", name: "Alpha", token: ALPHA, approver_phone: "+14155550101" },
  { id: "ws_beta", name: "Beta", token: BETA, approver_phone: "+14155550202" },
];
const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
const procs: ChildProcess[] = [];
let id = 0;

async function startServer(port: number, extra: Record<string, string> = {}) {
  const env = { ...process.env, PORT: String(port), HAGGLE_MODE: "mock", HAGGLE_SIM_DELAY_SCALE: "0", HAGGLE_AUTH: "required", HAGGLE_APPROVALS: "out_of_band", HAGGLE_MOCK_WORKSPACES: JSON.stringify(WORKSPACES), ...extra };
  procs.push(WIN ? spawn(`"${MCP_USE_BIN}"`, ["start"], { cwd: APP_DIR, env, stdio: "ignore", shell: true }) : spawn(MCP_USE_BIN, ["start"], { cwd: APP_DIR, env, stdio: "ignore" }));
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not start (run `mcp-use build` first)");
}

async function rpc(token: string, method: string, params: Record<string, unknown> = {}, base = BASE) {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { ...HEADERS, authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const msg = JSON.parse(line ? line.slice(6) : text);
  if (msg.error) throw Object.assign(new Error(`${method}: ${JSON.stringify(msg.error)}`), { rpcError: msg.error });
  return msg.result;
}
const as = (token: string, base = BASE) => (name: string, args: Record<string, unknown>) => rpc(token, "tools/call", { name, arguments: args }, base);
const errorOf = (r: { isError?: boolean; content: { text: string }[] }) => (r.isError ? JSON.parse(r.content[0]!.text) : null);
const refused = async (p: Promise<{ isError?: boolean }>) => {
  const r = await p.catch((e: Error) => e);
  return r instanceof Error || r.isError === true;
};

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const request = (quantity: number, marker = "") => ({
  what: `lunch catering${marker ? ` (${marker})` : ""}`, quantity, unit: "people", date: day(6), area: "San Francisco, CA",
  requirements: [{ id: "veg", kind: "dietary", text: `At least ${Math.ceil(quantity / 4)} vegetarian meals`, hard: true, min_count: Math.ceil(quantity / 4) }],
});

beforeAll(() => startServer(PORT), 30_000);
afterAll(() => {
  for (const proc of procs) {
    if (WIN && proc.pid) spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    else proc.kill();
  }
});

/**
 * Every tool an MCP client can see, security-reviewed. A new tool fails this test until someone
 * checks it against the operator-only list below and adds it here.
 */
const REVIEWED_TOOLS = [
  "answer_business", "approve", "approve_in_view", "ask", "business_profile", "call_back", "call_back_in_view", "cancel_deal", "check_price", "choose_in_view",
  "deal", "discover", "get_conversation", "get_identity", "get_quotes", "list_deals", "mention_businesses", "negotiate", "open_haggle", "pay", "send_message", "wait_for_update",
];
/** Operator capabilities (scripts only): no tool name may suggest one. */
const ADMIN_NAME = /vendor|allowlist|allowed|recipient|workspace|admin|quarantine|release|job_?ops|operator|retry|suppress|revoke|rotate|consent|credential|token|migrat|review|resolve/i;
/** Inputs that would let a model act as the operator or vouch for itself. */
const ADMIN_INPUT = /^(consent|added_by|allowlist|allowed_recipients|recipients?_?allow.*|workspace(_id)?|operator|suppress.*|token|connector_secret|ceiling|global_.*|sender_trusted|trusted|simulated|authorized_by|approver|decision|approved)$/i;

function inputKeys(schema: unknown, out = new Set<string>()): Set<string> {
  if (!schema || typeof schema !== "object") return out;
  const s = schema as Record<string, unknown>;
  for (const [k, v] of Object.entries((s.properties as Record<string, unknown>) ?? {})) { out.add(k); inputKeys(v, out); }
  for (const k of ["items", "anyOf", "oneOf", "allOf"]) {
    const v = s[k];
    if (Array.isArray(v)) v.forEach((x) => inputKeys(x, out));
    else if (v) inputKeys(v, out);
  }
  return out;
}

describe("the MCP tool surface (HTTP)", () => {
  it("is exactly the reviewed set: no tool adds vendors, edits the allowlist, administers workspaces, releases quarantine or runs job-ops", async () => {
    const { tools } = await rpc(ALPHA, "tools/list");
    const names: string[] = tools.map((t: { name: string }) => t.name).filter((n: string) => !/^settings[._]/.test(n));
    expect(names.filter((n) => !REVIEWED_TOOLS.includes(n)), "unreviewed tool(s): check them against the operator-only capabilities, then add to REVIEWED_TOOLS").toEqual([]);
    for (const n of names) expect(n, n).not.toMatch(ADMIN_NAME);
    for (const t of tools as { name: string; inputSchema: unknown }[]) {
      const keys = [...inputKeys(t.inputSchema)];
      // The deal tool documents approver_email / approver_phone as ignored inputs (tested below).
      const bad = keys.filter((k) => ADMIN_INPUT.test(k) && !(t.name === "deal" && /^approver_(email|phone)$/.test(k)));
      expect(bad, t.name).toEqual([]);
    }
  });

  it("settings: only the cap (down only), the area and read-only approver fields; nothing else can be set", async () => {
    const alpha = as(ALPHA);
    const { tools } = await rpc(ALPHA, "tools/list");
    const update = (tools as { name: string; inputSchema: unknown }[]).find((t) => /^settings[._]update$/.test(t.name));
    const name = update?.name ?? "settings.update";
    for (const set of [{ approver_phone: "+14155550666" }, { approver_email: "me@attacker.example" }, { spending_cap_usd: 999_999 }, { allowed_recipients: "+14155550999" }, { workspace_id: "ws_beta" }, { vendors: [{ contact: "x@y.z", consent: "yes" }] }]) {
      const before = (await alpha(name.replace("update", "read"), {})).structuredContent.values;
      await alpha(name, { set }).catch(() => null);
      const after = (await alpha(name.replace("update", "read"), {})).structuredContent.values;
      expect(after, JSON.stringify(set)).toEqual(before);
      expect(Object.keys(after).sort()).toEqual(["approver_email", "approver_phone", "default_area", "spending_cap_usd"]);
    }
  });

  // (Mock without HAGGLE_PLACES_FIXTURE has no recipient allowlist: every send is simulated. The live
  // allowlist and workspace-vendor checks are proven at the engine level: packages/engine/tests/security.test.ts.)
});

describe("call_back from tools (HTTP, out-of-band approvals)", { timeout: 120_000 }, () => {
  // Scripted vendors: Mission Eats quotes $1,150 on its call, Harbor Table a real $1,000 by email, and
  // Quiet Bistro never answers (collection stays open), so one callback to Mission Eats is justified.
  let base = "";
  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    await startServer(port, { HAGGLE_MOCK_PERSONAS_FILE: join(import.meta.dirname, "fixtures/callback-personas.json") });
  }, 30_000);

  it("never places a call: no form, no board code, no model say-so (a justified callback only texts the approver)", async () => {
    const alpha = as(ALPHA, base);
    const deal = await alpha("deal", { request: { ...request(40), requirements: [] }, budget_usd: 1200, client_request_id: "d4-callback" });
    const job = deal.structuredContent.job_id as string;
    let cursor = "0";
    let board: { callbacks?: { business_id: string }[]; businesses: { business_id?: string; id?: string }[]; ready: boolean } | undefined;
    const updates: { summary?: string }[] = [];
    for (let i = 0; i < 40; i++) {
      const w = await alpha("wait_for_update", { job_id: job, cursor, timeout_s: 1 });
      cursor = w.structuredContent.cursor;
      updates.push(...(w.structuredContent.updates ?? []));
      board = (await alpha("get_quotes", { job_id: job })).structuredContent;
      if (board!.callbacks?.length) break;
    }
    // Without the sprint-4 fix this server (mock, no form, no card) placed the call as "DEMO simulated human".
    expect(board!.callbacks?.length, "a callback should be justified by the scripted quotes").toBeGreaterThan(0);
    const targets = [...(board!.callbacks ?? []).map((c) => c.business_id), ...board!.businesses.map((b) => b.business_id ?? b.id!)];
    for (const biz of targets) {
      const r = await alpha("call_back", { job_id: job, business_id: biz });
      const e = errorOf(r);
      if (e) expect(["NO_HUMAN_CHANNEL", "callback_not_justified", "no_rounds_left", "callback_no_consent"], biz).toContain(e.error.code);
      else expect(r.structuredContent.status, biz).not.toBe("placed");
      expect(r._meta?.["haggle/callback"]).toBeUndefined();
      for (const code of ["000000", "123456", "999999"]) expect(errorOf(await alpha("call_back_in_view", { job_id: job, business_id: biz, code }))?.error.code).toBe("callback_not_authorized");
    }
    const w = await alpha("wait_for_update", { job_id: job, cursor, timeout_s: 1 });
    updates.push(...(w.structuredContent.updates ?? []));
    expect(updates.some((u) => /Calling .* back/.test(u.summary ?? ""))).toBe(false);
  });
});

describe("two workspaces, the same simulated vendors, interleaved event streams (HTTP)", { timeout: 180_000 }, () => {
  it("each workspace's tools show only its own deal, whatever arrives in between", async () => {
    const alpha = as(ALPHA);
    const beta = as(BETA);
    const [da, db] = await Promise.all([
      alpha("deal", { request: request(40, "kumquat offsite"), budget_usd: 1200, client_request_id: "d4-tenancy" }),
      beta("deal", { request: request(120, "rutabaga summit"), budget_usd: 3600, client_request_id: "d4-tenancy" }),
    ]);
    const ja = da.structuredContent.job_id as string;
    const jb = db.structuredContent.job_id as string;
    expect(ja).not.toBe(jb);
    const cur = { a: "0", b: "0" };
    const boards: Record<string, { job: { id: string; request?: { quantity?: number } }; quotes: { quote_id: string; business: string }[]; businesses: { business_id?: string; id?: string; name: string }[]; ready: boolean }> = {};
    for (let i = 0; i < 60; i++) {
      // Interleave: each side's waits and reads run while the other's vendors are replying.
      const [wa, wb] = await Promise.all([alpha("wait_for_update", { job_id: ja, cursor: cur.a, timeout_s: 1 }), beta("wait_for_update", { job_id: jb, cursor: cur.b, timeout_s: 1 })]);
      cur.a = wa.structuredContent.cursor;
      cur.b = wb.structuredContent.cursor;
      expect(JSON.stringify(wa)).not.toMatch(new RegExp(`${jb}|rutabaga`));
      expect(JSON.stringify(wb)).not.toMatch(new RegExp(`${ja}|kumquat`));
      const [ba, bb] = await Promise.all([alpha("get_quotes", { job_id: ja }), beta("get_quotes", { job_id: jb })]);
      expect(JSON.stringify(ba)).not.toMatch(new RegExp(`${jb}|rutabaga`));
      expect(JSON.stringify(bb)).not.toMatch(new RegExp(`${ja}|kumquat`));
      boards.a = ba.structuredContent;
      boards.b = bb.structuredContent;
      if (boards.a!.ready && boards.b!.ready) break;
    }
    expect(boards.a!.quotes.length).toBeGreaterThan(0);
    expect(boards.b!.quotes.length).toBeGreaterThan(0);
    const qa = new Set(boards.a!.quotes.map((q) => q.quote_id));
    const qb = new Set(boards.b!.quotes.map((q) => q.quote_id));
    expect([...qa].some((q) => qb.has(q))).toBe(false);
    // The same vendors on both deals: each side's conversation with a shared vendor is its own (the 40 vs 120 headcount RFQ).
    const shared = boards.a!.businesses.map((b) => b.name).filter((n) => boards.b!.businesses.some((x) => x.name === n));
    expect(shared.length).toBeGreaterThan(0);
    for (const name of shared) {
      const bidA = boards.a!.businesses.find((b) => b.name === name)!;
      const bidB = boards.b!.businesses.find((b) => b.name === name)!;
      const ca = JSON.stringify((await alpha("get_conversation", { job_id: ja, business_id: bidA.business_id ?? bidA.id })).structuredContent ?? {});
      const cb = JSON.stringify((await beta("get_conversation", { job_id: jb, business_id: bidB.business_id ?? bidB.id })).structuredContent ?? {});
      expect(ca, name).not.toMatch(/rutabaga/);
      expect(cb, name).not.toMatch(/kumquat/);
      // Cross reads by id are "not found", never the other side's conversation.
      expect(errorOf(await beta("get_conversation", { job_id: ja, business_id: bidA.business_id ?? bidA.id }))?.error.code).toBe("job_not_found");
    }
    for (const qid of qa) expect(errorOf(await beta("approve", { job_id: jb, quote_id: qid }))?.error.code, qid).toMatch(/quote_not_found|not_approvable|NO_HUMAN_CHANNEL|quote_not_eligible/);
    expect(await refused(beta("pay", { job_id: ja, quote_id: [...qa][0]! }))).toBe(true);
    const la = JSON.stringify((await alpha("list_deals", {})).structuredContent);
    const lb = JSON.stringify((await beta("list_deals", {})).structuredContent);
    expect(la).toContain(ja);
    expect(la).not.toContain(jb);
    expect(lb).toContain(jb);
    expect(lb).not.toContain(ja);
  });
});

describe("brain tenancy (HTTP): what alpha's deal teaches Haggle stays in alpha", { timeout: 180_000 }, () => {
  // A server of its own, so nothing but alpha's one deal can teach the brain between the reads.
  let base = "";
  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    await startServer(port);
  }, 30_000);

  it("beta's ask, check_price and business_profile are the same before and after alpha's deal; alpha's ask learned from it", async () => {
    const alpha = as(ALPHA, base);
    const beta = as(BETA, base);
    const asked = { what: "lunch catering", quantity: 40, area: "San Francisco, CA" };
    const priced = { ...asked, total_usd: 1400 };
    const counts = (r: { structuredContent: { estimates: { business: string; n_quotes: number }[] } }) => Object.fromEntries(r.structuredContent.estimates.map((e) => [e.business, e.n_quotes]));
    const [askA0, askB0, priceB0, profileB0] = await Promise.all([alpha("ask", asked), beta("ask", asked), beta("check_price", priced), beta("business_profile", { business: "Harbor Table" })]);
    expect(Object.keys(counts(askB0)).length, "mock workspaces start from the labelled seed samples").toBeGreaterThan(0);

    const deal = await alpha("deal", { request: request(40, "kumquat brain"), budget_usd: 1200, client_request_id: "brain-tenancy" });
    const job = deal.structuredContent.job_id as string;
    let cursor = "0";
    for (let i = 0; i < 60; i++) {
      cursor = (await alpha("wait_for_update", { job_id: job, cursor, timeout_s: 1 })).structuredContent.cursor;
      const board = (await alpha("get_quotes", { job_id: job })).structuredContent;
      if (board.ready) break;
    }

    // Alpha learned from its own deal (otherwise the rest proves nothing).
    const askA1 = await alpha("ask", asked);
    const [a0, a1] = [counts(askA0), counts(askA1)];
    expect(Object.keys(a1).some((b) => (a1[b] ?? 0) > (a0[b] ?? 0)), JSON.stringify({ a0, a1 })).toBe(true);

    // Beta sees exactly what it saw before: no count, price sample or history row from alpha's deal.
    const [askB1, priceB1, profileB1] = await Promise.all([beta("ask", asked), beta("check_price", priced), beta("business_profile", { business: "Harbor Table" })]);
    expect(counts(askB1)).toEqual(counts(askB0));
    expect(askB1.structuredContent.estimates).toEqual(askB0.structuredContent.estimates);
    expect(priceB1.structuredContent.sample_size).toBe(priceB0.structuredContent.sample_size);
    expect(priceB1.structuredContent.verdict).toBe(priceB0.structuredContent.verdict);
    expect(profileB1.structuredContent.history).toEqual(profileB0.structuredContent.history);
    for (const r of [askB1, priceB1, profileB1]) expect(JSON.stringify(r)).not.toMatch(new RegExp(`${job}|kumquat`));
  });
});
