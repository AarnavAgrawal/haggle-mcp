// P0 regression (2026-10-17): the natural-language procurement journey from Claude.ai.
//
//   "Use Haggle to help me plan a hackathon that I need to cater for that has 200 people next Saturday
//    at the YC HQ in San Francisco. No preference for cuisine, budget under 5k."
//
// Before: the model called ask (seed samples), business_profile ×6, then deal(discover) was refused
// (discovered sellers weren't authorized) and the $5k budget was reported as a $1,500 cap. After:
// deal is the documented first call; with no businesses it uses the ready demo vendors, opens the
// deal board at once with the exact request, and keeps the budget separate from payment ceilings.
// When no vendor is set up, it starts nothing and returns the blockers for the "Setup needed" board.
//
// The model's tool choice is checked against real Claude by scripts/acceptance/nl-journey.mjs; this
// suite pins the server side: tool metadata that steers the model, and what each plausible call
// returns. Real production build (`mcp-use start`) in MOCK mode, over HTTP. Run `mcp-use build` first.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DealBoardPlus } from "../src/views.ts";

const APP_DIR = join(import.meta.dirname, "..");
// On Windows the runnable shim is mcp-use.cmd, which needs a shell (and a quoted path); stop the whole tree.
const WIN = process.platform === "win32";
const MCP_USE_BIN = [join(APP_DIR, "node_modules/.bin/mcp-use"), join(APP_DIR, "../../node_modules/.bin/mcp-use")].map((p) => (WIN ? `${p}.cmd` : p)).find((p) => existsSync(p)) ?? "mcp-use";
const startServer = (env: NodeJS.ProcessEnv): ChildProcess =>
  WIN ? spawn(`"${MCP_USE_BIN}"`, ["start"], { cwd: APP_DIR, stdio: "ignore", env, shell: true }) : spawn(MCP_USE_BIN, ["start"], { cwd: APP_DIR, stdio: "ignore", env });
const stopServer = (proc: ChildProcess | undefined): void => {
  if (WIN && proc?.pid) spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  else proc?.kill();
};

export const HACKATHON_PROMPT =
  "Use Haggle to help me plan a hackathon that I need to cater for that has 200 people next Saturday at the YC HQ in San Francisco. No preference for cuisine, budget under 5k.";

/** "next Saturday" from today (a Saturday → the one after). */
function nextSaturday(from = new Date()): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + (((6 - d.getUTCDay() + 7) % 7) || 7));
  return d.toISOString().slice(0, 10);
}
const SAT = nextSaturday();
const SAT_WORDS = new Date(`${SAT}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
      const p = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });

type Server = { proc: ChildProcess; base: string; id: number };
async function start(env: Record<string, string>): Promise<Server> {
  const port = await freePort();
  const proc = startServer({ ...process.env, PORT: String(port), HAGGLE_MODE: "mock", HAGGLE_SIM_DELAY_SCALE: "0", ...env });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return { proc, base, id: 0 };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not start (run `mcp-use build` first)");
}
async function rpc(s: Server, method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(`${s.base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++s.id, method, params }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const msg = JSON.parse(line ? line.slice(6) : text);
  if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
  return msg.result;
}
const call = (s: Server, name: string, args: Record<string, unknown>) => rpc(s, "tools/call", { name, arguments: args });

/** What Claude sends for HACKATHON_PROMPT (and close variations), per the deal tool's description. */
const hackathon = (over: Record<string, unknown> = {}) => ({
  request: { what: "hackathon catering", quantity: 200, date: SAT, area: "San Francisco, CA", venue: "YC HQ", requirements: [] },
  budget_usd: 5000,
  ...over,
});

let ready: Server;
let blocked: Server;
beforeAll(async () => {
  [ready, blocked] = await Promise.all([start({}), start({ HAGGLE_MOCK_VENDORS: "none" })]);
}, 40_000);
afterAll(() => {
  stopServer(ready?.proc);
  stopServer(blocked?.proc);
});

describe(`P0 journey: "${HACKATHON_PROMPT.slice(0, 60)}…"`, () => {
  it("tool metadata sends procurement straight to deal, which renders the board", async () => {
    const init = await rpc(ready, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "journey", version: "1" } });
    // Intake first (one compact message for the essentials), then deal; needs_info sends nothing.
    expect(init.instructions).toMatch(/in ONE short message, ask the user for the essentials that are missing/);
    expect(init.instructions).toMatch(/Then call deal with the request and budget_usd/);
    expect(init.instructions).toMatch(/If deal returns needs_info, nothing was sent/);
    expect(init.instructions).toMatch(/Don't call ask, discover or business_profile first/);
    const { tools } = await rpc(ready, "tools/list");
    const t = Object.fromEntries(tools.map((x: { name: string }) => [x.name, x]));
    expect(t.deal.description).toMatch(/START HERE for any purchase or procurement request: catering, food for an event or hackathon/);
    expect(t.deal.description).toMatch(/'under 5k' = 5000/);
    expect(t.deal.inputSchema.required).toEqual(["request"]); // businesses optional
    expect(JSON.stringify(t.deal._meta)).toContain("deal-live"); // one live board per deal (decision 6)
    expect(t.ask.description).toMatch(/If the user wants to buy, cater, book or plan a purchase, call deal instead/);
    expect(t.discover.description).toMatch(/Not needed before a deal with the configured vendors/);
  });

  it("the exact prompt: one deal call starts the job on all six demo vendors and returns the live board", async () => {
    const r = await call(ready, "deal", hackathon());
    expect(r.isError).toBeFalsy();
    const v = r.structuredContent;
    expect(DealBoardPlus.safeParse(v).success).toBe(true);
    expect(v).toMatchObject({ ok: true, mode: "mock", empty: false, job: { state: expect.any(String) } });
    expect(v.request_details).toMatchObject({ what: "hackathon catering", headcount: 200, date: SAT, budget_usd: 5000, budget_source: "request", place: "YC HQ, San Francisco, CA" });
    expect(v.request_details.when).toBe(SAT_WORDS);
    expect(v.job.budget_usd).toBe(5000); // the user's budget, not the $1,500 settings default
    expect(v.payment_ceiling_usd).toBeLessThanOrEqual(5000); // payments have their own, separate ceiling
    expect(v.businesses).toHaveLength(6);
    expect(new Set(v.businesses.map((b: { channel: string }) => b.channel))).toEqual(new Set(["email", "phone", "a2a"]));
    expect(v.businesses.every((b: { simulated: boolean }) => b.simulated)).toBe(true);
    expect(v.setup).toEqual({ ready: 6, total: 6, blockers: [] });
    expect(v.next).toMatch(/wait_for_update\(job_id='job_/);
    const text: string = r.content[0].text;
    expect(text).toMatch(/^\[DEMO\] Deal job_\w+ started: hackathon catering for 200, /);
    expect(text).toContain(SAT_WORDS);
    expect(text).toMatch(/budget \$5,000/);
    expect(text).not.toMatch(/\$1,500/);

    // Async updates arrive and the board (same view data via get_quotes) fills in.
    let cursor = "0";
    let board = v;
    for (let i = 0; i < 40 && board.quotes.length < 3; i++) {
      cursor = (await call(ready, "wait_for_update", { job_id: v.job_id, cursor, timeout_s: 1 })).structuredContent.cursor;
      board = (await call(ready, "get_quotes", { job_id: v.job_id })).structuredContent;
    }
    expect(board.quotes.length).toBeGreaterThanOrEqual(3);
    expect(board.request_details.headcount).toBe(200);

    // open_haggle (the launcher) shows the same active deal.
    const open = (await call(ready, "open_haggle", {})).structuredContent;
    expect(open.job.id).toBe(v.job_id);

    // A new conversation without ids: list_deals finds it, then get_quotes(job_id); every vendor has a stage.
    // get_quotes() without an id never guesses: it lists the recent deals and asks.
    const deals = (await call(ready, "list_deals", {})).structuredContent.deals;
    expect(deals[0]).toMatchObject({ job_id: v.job_id, what: "hackathon catering", quantity: 200 });
    const guess = await call(ready, "get_quotes", {});
    expect(guess.isError).toBe(true);
    expect(JSON.parse(guess.content[0].text).error).toMatchObject({ code: "job_id_required", message: expect.stringContaining(v.job_id) });
    const resumed = (await call(ready, "get_quotes", { job_id: deals[0].job_id })).structuredContent;
    expect(resumed.job_id).toBe(v.job_id);
    expect(Object.keys(resumed.stages)).toHaveLength(6);
    for (const st of Object.values(resumed.stages) as { stage: string }[]) expect(st.stage).toMatch(/^(waiting|quoted|countered|vendor_revised|held_firm|final|excluded|asked_question|clarifying|responded|no_reply|calling|declined|unreachable)$/);
  });

  it("variations: noon + 40 vegetarian; no budget stated; a past date; a typed-in vendor list", async () => {
    const veg = await call(ready, "deal", hackathon({
      request: { what: "catering", quantity: 200, date: SAT, time: "12:00", area: "San Francisco, CA", venue: "YC office", requirements: [{ kind: "dietary", text: "40 vegetarian meals", min_count: 40 }] },
    }));
    expect(veg.structuredContent.request_details).toMatchObject({ when: `${SAT_WORDS} at 12:00 PM`, requirements: ["40 vegetarian meals"], budget_usd: 5000 });

    const noBudget = await call(ready, "deal", hackathon({ budget_usd: undefined }));
    expect(noBudget.structuredContent.request_details).toMatchObject({ budget_usd: null });
    expect(noBudget.structuredContent.job.budget_usd).toBeUndefined(); // never a settings value posing as the client's target
    expect(noBudget.structuredContent.warnings.join(" ")).toMatch(/No budget given, so none was assumed/);

    const past = await call(ready, "deal", hackathon({ request: { what: "catering", quantity: 200, date: "2020-01-04", area: "San Francisco, CA" } }));
    expect(past.isError).toBe(true);
    expect(JSON.parse(past.content[0].text).error).toMatchObject({ code: "date_in_past", fix: expect.stringMatching(/next Saturday/) });

    // Named businesses are used as given (no roster setup panel); live mode still enforces its recipient allowlist (engine tests).
    const named = await call(ready, "deal", hackathon({ businesses: [{ name: "Golden Grill", email: "sales@golden-grill.sim.haggle.dev" }] }));
    expect(named.structuredContent.businesses).toHaveLength(1);
    expect(named.structuredContent.setup).toBeUndefined();
  });

  it("nothing set up: deal starts nothing and returns the exact blockers for the Setup needed board", async () => {
    const before = (await call(blocked, "discover", {})).structuredContent;
    expect(before).toMatchObject({ ready: 0, total: 6 });
    expect(before.businesses.every((b: { ready: boolean; blocker?: string; fix?: string }) => !b.ready && b.blocker && b.fix)).toBe(true);

    const r = await call(blocked, "deal", hackathon());
    expect(r.isError).toBeFalsy(); // a result the board renders, not a crash
    expect(r.structuredContent).toMatchObject({ ok: false, job: null, empty: true, setup: { ready: 0, total: 6 } });
    expect(r.structuredContent.setup.blockers).toHaveLength(6);
    expect(r.structuredContent.setup.blockers[0]).toMatchObject({ vendor: "Harbor Table", channel: "email", fix: expect.stringContaining("HAGGLE_DEMO_VENDORS") });
    expect(r.content[0].text).toMatch(/NOT STARTED: none of the 6 demo vendors can be contacted from this server yet\. Nothing was sent\./);
    expect((await call(blocked, "open_haggle", {})).structuredContent).toMatchObject({ job: null, setup: { ready: 0 } });
  });
});

// P0 regression (2026-10-18), Claude.ai: "I need drop-off catering for 25 people in San Francisco next
// week, including 5 vegetarian meals. My target budget is $500 all-in. Use Mission Eats ONLY, …".
// Before: deal required each named business's raw email/phone, so Claude (correctly) wouldn't omit the
// vendor list and couldn't start the deal without asking the user for Mission Eats' phone number,
// which the server already had. After: names are enough, and exactly the named vendors are contacted.
describe("named vendors: 'Use Mission Eats ONLY'", () => {
  const missionOnly = (over: Record<string, unknown> = {}) => hackathon({
    request: { what: "drop-off catering", quantity: 25, date: SAT, area: "San Francisco, CA", requirements: [{ kind: "dietary", text: "5 vegetarian meals", min_count: 5 }] },
    budget_usd: 500, businesses: ["Mission Eats"], ...over,
  });
  const dealCount = async () => (await call(ready, "list_deals", { limit: 20 })).structuredContent.deals.length;

  it("tool metadata: names are enough, and the model must never ask for a known vendor's contact", async () => {
    const init = await rpc(ready, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "journey", version: "1" } });
    expect(init.instructions).toMatch(/deal\(businesses=\['Mission Eats'\]\)/);
    expect(init.instructions).toMatch(/never ask the user for a phone number or email of a vendor Haggle knows/);
    const { tools } = await rpc(ready, "tools/list");
    const deal = tools.find((t: { name: string }) => t.name === "deal");
    expect(deal.description).toMatch(/never ask the user for a vendor's phone or email/);
    expect(JSON.stringify(deal.inputSchema.properties.businesses)).toMatch(/"type":"string"/); // a bare name is valid input
  });

  it("dry run: exactly one vendor would be contacted, nothing is sent and no deal starts", async () => {
    const before = await dealCount();
    const r = await call(ready, "deal", missionOnly({ dry_run: true }));
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ dry_run: true, job: null, would_contact: [{ name: "Mission Eats", business_ref: "mission_eats", contact_state: expect.stringMatching(/^(authorized|verified_responsive)$/), ready: true }] });
    expect(r.structuredContent.would_contact).toHaveLength(1);
    expect(r.content[0].text).toMatch(/DRY RUN \(nothing sent\): deal would contact exactly 1: Mission Eats/);
    expect(await dealCount()).toBe(before);
  });

  it("the deal contacts Mission Eats and nobody else; a chosen subset is exactly that subset", async () => {
    const one = (await call(ready, "deal", missionOnly())).structuredContent;
    expect(one.ok).toBe(true);
    expect(one.businesses.map((b: { name: string }) => b.name)).toEqual(["Mission Eats"]);
    expect(one.contacted.map((c: { business: string }) => c.business)).toEqual(["Mission Eats"]);
    expect(one.setup).toBeUndefined();
    const two = (await call(ready, "deal", missionOnly({ businesses: ["Harbor Table", "golden_grill"] }))).structuredContent;
    expect(two.businesses.map((b: { name: string }) => b.name).sort()).toEqual(["Golden Grill", "Harbor Table"]);
  });

  it("an unknown name starts nothing and says what to ask; no other vendor is contacted instead", async () => {
    const before = await dealCount();
    const r = await call(ready, "deal", missionOnly({ businesses: ["Mission Eats", "Taco Palace"] }));
    expect(r.isError).toBe(true);
    const e = JSON.parse(r.content[0].text).error;
    expect(e).toMatchObject({ code: "unknown_business", message: expect.stringContaining("Nothing was sent"), fix: expect.stringContaining("Ask the user") });
    expect(await dealCount()).toBe(before);
  });

  it("'next week' is a flexible window, not a day Haggle picked; a reversed window is refused", async () => {
    const end = new Date(Date.parse(`${SAT}T00:00:00Z`) + 4 * 86_400_000).toISOString().slice(0, 10);
    const r = (await call(ready, "deal", missionOnly({ request: { what: "drop-off catering", quantity: 25, date: SAT, date_until: end, area: "San Francisco, CA", requirements: [] } }))).structuredContent;
    expect(r.request_details.when).toMatch(/^any day .+ – .+ \(flexible\)$/);
    const bad = await call(ready, "deal", missionOnly({ request: { what: "catering", quantity: 25, date: end, date_until: SAT, area: "San Francisco, CA", requirements: [] } }));
    expect(JSON.parse(bad.content[0].text).error.code).toBe("bad_date_range");
  });

  it("business_profile and discover give the same reference deal accepts", async () => {
    const d = (await call(ready, "discover", {})).structuredContent;
    expect(d.businesses.find((b: { name: string }) => b.name === "Mission Eats")).toMatchObject({ business_ref: "mission_eats", ready: true });
    expect(d.next).toMatch(/businesses=\['<name>'/);
    const p = await call(ready, "business_profile", { business: "Mission Eats" });
    expect(p.structuredContent).toMatchObject({ name: "Mission Eats", business_ref: "mission_eats", configured_vendor: true, ready: true });
    expect(p.structuredContent.next).toMatch(/businesses=\['Mission Eats'\]\): Haggle already has its contact details/);
    const viaRef = (await call(ready, "deal", missionOnly({ businesses: [p.structuredContent.business_ref], dry_run: true }))).structuredContent;
    expect(viaRef.would_contact.map((w: { name: string }) => w.name)).toEqual(["Mission Eats"]);
  });
});

// P0 2026-10-18, fresh Claude.ai: "I need catering for about 50 people in San Francisco next Saturday. Can you
// find me the best deal?" Claude sent deal({what:"catering", quantity:50, date:<next Saturday>, area:"San
// Francisco", unit:"people"}). Live: both attempts failed (jobs_max_rounds_check: config 3, schema 1..2; see
// packages/engine/tests/liveRounds.test.ts), the error told Claude to call get_quotes, and get_quotes() with no
// job_id fell back to the newest open deal: an unrelated 200-person board with an Approve button.
describe("the one-sentence request: 'catering for about 50 people in San Francisco next Saturday'", () => {
  const exact = { request: { what: "catering", quantity: 50, date: SAT, area: "San Francisco", unit: "people" } };

  it("starts exactly that deal: no budget, time or requirement invented, the board is the new job's", async () => {
    const old = (await call(ready, "deal", hackathon())).structuredContent.job_id; // an unrelated earlier deal exists
    const r = await call(ready, "deal", exact);
    expect(r.isError).toBeFalsy();
    const v = r.structuredContent;
    expect(v.ok).toBe(true);
    expect(v.job_id).not.toBe(old);
    expect(v.job.id).toBe(v.job_id);
    expect(v.request_details).toMatchObject({ what: "catering", headcount: 50, date: SAT, when: SAT_WORDS, requirements: [], budget_usd: null });
    expect(v.request_details.time).toBeUndefined();
    expect(v.job.budget_usd).toBeUndefined();
    expect(v.next).toContain(v.job_id);
    // Following the board: always this job, never the 200-person one.
    const board = (await call(ready, "get_quotes", { job_id: v.job_id })).structuredContent;
    expect(board).toMatchObject({ job_id: v.job_id, request_details: { headcount: 50 } });
  });

  it("a failed or unidentified request never surfaces an earlier deal as the answer", async () => {
    const r = await call(ready, "get_quotes", {});
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.job ?? null).toBeNull();
    expect(JSON.parse(r.content[0].text).error.fix).toMatch(/that's a new deal: call deal, not an earlier one/);
    const tooMany = await call(ready, "deal", { ...exact, max_rounds: 3 });
    expect(tooMany.isError).toBe(true); // the schema says at most 2; it never reaches the database
  });
});
