// Overnight sprint B (2026-10-22): workspace isolation on Haggle's one shared text line. A text from
// a number reaches a deal only through durable, workspace-scoped records (the workspace's approver,
// a business Haggle contacted at that number, text_routes / held_texts), never through one
// process's memory, and never by guessing between two workspaces. Two workspaces, interleaved
// texts, emails and calls; two engines sharing one store; a restart mid-conversation. Real engine,
// fake ports; no network. The Postgres block runs under scripts/test-postgres.sh.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, type EngineConfig, type SmsPort } from "../src/index.ts";
import { PostgresRepository } from "../src/store/postgres.ts";
import type { Repository } from "../src/store/types.ts";
import { decideTextScope, jobCodeIn, withoutJobCode } from "../src/workflow/textRouting.ts";

const ALPHA_HUMAN = "+14155550101";
const BETA_HUMAN = "+14155550202";
const SHARED_HUMAN = "+14155550303";
const GRILL = "+14085550123";
const { budget_usd, ...request } = GOLDEN_REQUEST;

// Reads figures and questions out of free text, like the Claude extractor does live.
const textExtractor = {
  async extract(i: { bodyText: string }) {
    const t = (i.bodyText.split("[The business's reply]:")[1] ?? i.bodyText).split("\n").filter((l) => !/^\s*(local|haggle)\s*:/i.test(l)).join("\n");
    const money = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
    const total = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*(?:total|all[- ]in)/i);
    const deposit = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*deposit/i);
    const questions = t.split(/(?<=\?)/).map((s) => s.trim()).filter((s) => s.endsWith("?"));
    return {
      available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true,
      tax_usd: null, tax_included: true, total_usd: total, deposit_usd: deposit, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }],
      valid_until: null, questions: total === null ? questions : [], payment_request: "none" as const, instructions_to_agent: false,
      sources: [...(total !== null ? [{ field: "total" as const, source: "text", excerpt: `$${total} total` }] : []), ...(deposit !== null ? [{ field: "deposit" as const, source: "text", excerpt: `$${deposit} deposit` }] : [])],
      missing_fields: total === null ? ["total"] : [], confidence: 0.9,
    };
  },
};
const trusted = (expected: string) => ({ trusted: true as const, address: expected, reason: "trusted" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });

type Sent = { to: string; text: string; idempotencyKey: string };

/** One engine (one server process) over a store that may be shared with others. */
function instance(repo: Repository, opts: { sms?: SmsPort; config?: Partial<EngineConfig>; clock?: { now: () => Date } } = {}) {
  const texts: Sent[] = [];
  const emails: { to: string; subject: string; bodyText: string }[] = [];
  const calls: { toNumber: string; idempotencyKey?: string }[] = [];
  const sms: SmsPort = opts.sms ?? { async send(r) { texts.push(r); return { messageId: `sms_${Math.random().toString(36).slice(2, 10)}` }; } };
  const engine = new HaggleEngine({
    repo, ...(opts.clock ? { now: opts.clock.now } : {}), extractor: textExtractor as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}_${Math.random().toString(36).slice(2, 8)}`, status: "sent", idempotentReplay: false, messageId: `<em_${Math.random().toString(36).slice(2, 10)}@haggle.test>` }; } },
    phone: { async placeCall(r) { calls.push(r); return { callId: `call_${Math.random().toString(36).slice(2, 10)}` }; } },
    sms,
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 50_000, maxRounds: 1, ...opts.config,
    },
  });
  return { engine, texts, emails, calls };
}

async function workspaces(repo: Repository, engine: HaggleEngine, approvers: Record<string, string>) {
  for (const [id, phone] of Object.entries(approvers)) {
    if (!(await repo.getWorkspace(id))) await repo.insertWorkspace({ id, name: id, token_hash: null, connector_secret_hash: null, timezone: "America/Los_Angeles" });
    await engine.updateSettings({ approver_phone: phone, spending_cap_cents: 50_000 }, id, "operator");
  }
}

const uniq = () => Math.random().toString(36).slice(2, 8);
const inbound = async (repo: Repository, jobId: string) => (await repo.listMessages(jobId)).filter((m) => m.direction === "in");

describe("text routing helpers", () => {
  it("reads and strips the deal code the sender added; the scope never guesses between workspaces", () => {
    expect(jobCodeIn("HG-ab12: drop-off is fine")).toBe("AB12");
    expect(withoutJobCode("HG-AB12: drop-off is fine")).toBe("drop-off is fine");
    expect(withoutJobCode("YES 4821 (HG-AB12)")).toBe("YES 4821");
    expect(withoutJobCode("we quoted HG-AB12 yesterday, $900 total")).toBe("we quoted HG-AB12 yesterday, $900 total");
    const job = (id: string, ws: string, code: string) => ({ id, workspace_id: ws, short_code: code }) as never;
    const owners = new Map([["ws_a", [job("j1", "ws_a", "AAAA")]], ["ws_b", [job("j2", "ws_b", "BBBB")]]]);
    expect(decideTextScope(new Map(), "hi")).toEqual({ kind: "none" });
    expect(decideTextScope(new Map([["ws_a", [job("j1", "ws_a", "AAAA")]]]), "hi")).toMatchObject({ kind: "workspace", workspaceId: "ws_a", jobId: null });
    expect(decideTextScope(owners, "hi")).toMatchObject({ kind: "ambiguous", workspaces: ["ws_a", "ws_b"] });
    expect(decideTextScope(owners, "HG-BBBB: hi")).toMatchObject({ kind: "workspace", workspaceId: "ws_b", jobId: "j2", text: "hi" });
    expect(decideTextScope(owners, "YES 4821", ["ws_a"])).toMatchObject({ kind: "workspace", workspaceId: "ws_a" });
    expect(decideTextScope(owners, "YES 4821", ["ws_a", "ws_b"])).toMatchObject({ kind: "ambiguous" });
    expect(decideTextScope(owners, "HG-ZZZZ hi")).toMatchObject({ kind: "ambiguous" }); // a code of neither decides nothing
  });
});

describe("two workspaces on one text line (in memory)", () => {
  it("one vendor number on deals in two workspaces: a text that doesn't say which is held for both, never guessed; the business is asked in words, and naming the request (or an old deal code) routes it", async () => {
    const repo = new InMemoryRepository();
    const { engine, texts } = instance(repo);
    await workspaces(repo, engine, { ws_alpha: ALPHA_HUMAN, ws_beta: BETA_HUMAN });
    const a = await engine.forWorkspace("ws_alpha").deal({ request, budget_usd, businesses: [{ name: "Golden Grill", phone: GRILL, channel: "imessage" }] });
    const b = await engine.forWorkspace("ws_beta").deal({ request: { ...request, what: "dinner buffet", quantity: 25 }, budget_usd, businesses: [{ name: "Golden Grill", phone: GRILL, channel: "imessage" }] });
    for (const t of texts.filter((x) => x.to === GRILL)) expect(t.text).not.toMatch(/HG-/); // no codes to the business
    const r = await engine.ingestText({ messageId: "g1", from: GRILL, text: "$1,020 total all-in, delivered, $100 deposit", inbound: true });
    expect(r).toEqual({ jobId: null, outcome: "ambiguous_workspace" });
    expect(await inbound(repo, a.job_id)).toEqual([]);
    expect(await inbound(repo, b.job_id)).toEqual([]);
    for (const id of [a.job_id, b.job_id]) {
      const held = (await repo.listEvents(id)).find((e) => e.data.kind === "text_held");
      expect(String(held?.data.summary)).toMatch(/asked Golden Grill which request/);
      expect(String(held?.data.summary)).not.toMatch(/1,020|HG-/); // nothing of the text reaches either deal
    }
    // The business is asked once, in plain words, listing only the requests it was contacted about.
    const which = texts.filter((x) => x.to === GRILL && /more than one request/.test(x.text));
    expect(which).toHaveLength(1);
    expect(which[0]!.text).toMatch(/dinner buffet for 25/);
    expect(which[0]!.text).not.toMatch(/HG-|Haggle/);
    // Naming the request routes it to that deal only.
    expect(await engine.ingestText({ messageId: "g1b", from: GRILL, text: "For the dinner buffet for 25: $980 total all-in, delivered", inbound: true })).toEqual({ jobId: b.job_id, outcome: "stored" });
    expect(await inbound(repo, b.job_id)).toHaveLength(1);
    expect(await inbound(repo, a.job_id)).toEqual([]);
    // Webhook redelivery of the held text: still nothing routed.
    expect((await engine.ingestText({ messageId: "g1", from: GRILL, text: "$1,020 total all-in, delivered, $100 deposit", inbound: true })).outcome).toBe("duplicate");
    const code = (await repo.getJob(a.job_id))!.short_code;
    expect(await engine.ingestText({ messageId: "g2", from: GRILL, text: `HG-${code} $1,020 total all-in, delivered, $100 deposit`, inbound: true })).toEqual({ jobId: a.job_id, outcome: "stored" });
    expect(await inbound(repo, a.job_id)).toHaveLength(1);
    expect(await inbound(repo, b.job_id)).toHaveLength(1);
  });

  it("a human who approves for two workspaces: a bare answer is held and they're asked for the deal code; the coded answer reaches that deal's business only, without the code", async () => {
    const repo = new InMemoryRepository();
    const { engine, texts } = instance(repo);
    await workspaces(repo, engine, { ws_alpha: SHARED_HUMAN, ws_beta: SHARED_HUMAN });
    const [va, vb] = ["+14085550111", "+14085550222"];
    const a = await engine.forWorkspace("ws_alpha").deal({ request, budget_usd, businesses: [{ name: "Alpha Grill", phone: va, channel: "imessage" }] });
    const b = await engine.forWorkspace("ws_beta").deal({ request, budget_usd, businesses: [{ name: "Beta Grill", phone: vb, channel: "imessage" }] });
    await engine.ingestText({ messageId: "qa", from: va, text: "Do you need plates and cutlery?", inbound: true });
    await engine.advanceJob(a.job_id);
    await engine.ingestText({ messageId: "qb", from: vb, text: "Should we stay to serve?", inbound: true });
    await engine.advanceJob(b.job_id);
    expect(texts.filter((t) => t.to === SHARED_HUMAN && /asks/.test(t.text))).toHaveLength(2);

    const r = await engine.ingestText({ messageId: "h1", from: SHARED_HUMAN, text: "Just the food, thanks.", inbound: true });
    expect(r.outcome).toBe("ambiguous_workspace");
    expect(texts.at(-1)).toMatchObject({ to: SHARED_HUMAN });
    expect(texts.at(-1)!.text).toMatch(/more than one Haggle account/);
    for (const id of [a.job_id, b.job_id]) expect((await repo.listQuestions(id)).every((q) => q.status === "pending")).toBe(true);

    const code = (await repo.getJob(b.job_id))!.short_code;
    expect(await engine.ingestText({ messageId: "h2", from: SHARED_HUMAN, text: `HG-${code}: Just the food, thanks.`, inbound: true })).toMatchObject({ jobId: b.job_id, outcome: "answered" });
    expect((await repo.listQuestions(b.job_id))[0]).toMatchObject({ status: "answered", answer: "Just the food, thanks." });
    expect((await repo.listQuestions(a.job_id))[0]!.status).toBe("pending");
    expect(texts.filter((t) => t.to === vb).at(-1)!.text).toMatch(/Just the food, thanks\./);
    expect(texts.filter((t) => t.to === vb).at(-1)!.text).not.toMatch(new RegExp(`HG-${code}:`));
    expect(texts.filter((t) => t.to === va).some((t) => /Just the food/.test(t.text))).toBe(false);
  });

  it("YES <code>: decides only when exactly one workspace has the code; the same code on two workspaces is refused until the deal code says which", async () => {
    const repo = new InMemoryRepository();
    const { engine } = instance(repo);
    await workspaces(repo, engine, { ws_alpha: SHARED_HUMAN, ws_beta: SHARED_HUMAN });
    const deals: { jobId: string; approvalId: string }[] = [];
    for (const [ws, phone] of [["ws_alpha", "+14085550111"], ["ws_beta", "+14085550222"]] as const) {
      const w = engine.forWorkspace(ws);
      const d = await w.deal({ request, budget_usd, businesses: [{ name: `${ws} Grill`, phone, channel: "imessage" }] });
      await engine.ingestText({ messageId: `quote_${ws}`, from: phone, text: "$1,020 total all-in, delivered, $100 deposit", inbound: true });
      await engine.advanceJob(d.job_id);
      const q = (await w.getQuotes(d.job_id)).quotes[0]!;
      const pending = await repo.getLatestApproval(d.job_id);
      const ap = pending?.status === "pending" ? pending : await w.requestApproval(d.job_id, q.quote_id, "view", undefined, { text: true });
      deals.push({ jobId: d.job_id, approvalId: ap.id });
    }
    for (const d of deals) await repo.updateApproval(d.approvalId, { code: "4242" });
    expect((await engine.ingestText({ messageId: "y1", from: SHARED_HUMAN, text: "YES 4242", inbound: true })).outcome).toBe("ambiguous_workspace");
    for (const d of deals) expect((await repo.getApproval(d.approvalId))!.status).toBe("pending");
    const alphaCode = (await repo.getJob(deals[0]!.jobId))!.short_code;
    expect(await engine.ingestText({ messageId: "y2", from: SHARED_HUMAN, text: `YES 4242 HG-${alphaCode}`, inbound: true })).toMatchObject({ jobId: deals[0]!.jobId, outcome: "approved" });
    expect((await repo.getApproval(deals[0]!.approvalId))!.status).toBe("approved");
    expect((await repo.getApproval(deals[1]!.approvalId))!.status).toBe("pending");
    // Beta's code differs now: a plain YES with it decides Beta alone.
    await repo.updateApproval(deals[1]!.approvalId, { code: "5151" });
    expect(await engine.ingestText({ messageId: "y3", from: SHARED_HUMAN, text: "YES 5151", inbound: true })).toMatchObject({ jobId: deals[1]!.jobId, outcome: "approved" });
  });

  it("a text from one workspace's approver never stores on, or texts, another workspace's deal (a code nothing matches)", async () => {
    const repo = new InMemoryRepository();
    const { engine, texts } = instance(repo);
    await workspaces(repo, engine, { ws_alpha: ALPHA_HUMAN, ws_beta: BETA_HUMAN });
    // Beta's deal is the first open job: the old fallback ("any open job") picked it.
    const b = await engine.forWorkspace("ws_beta").deal({ request, budget_usd, businesses: [{ name: "Beta Grill", phone: "+14085550222", channel: "imessage" }] });
    const a = await engine.forWorkspace("ws_alpha").deal({ request, budget_usd, businesses: [{ name: "Alpha Grill", phone: "+14085550111", channel: "imessage" }] });
    const before = texts.length;
    const r = await engine.ingestText({ messageId: "x1", from: ALPHA_HUMAN, text: "YES 9999", inbound: true });
    expect(r).toMatchObject({ jobId: a.job_id, outcome: "no_matching_approval" });
    expect(await inbound(repo, b.job_id)).toEqual([]);
    expect(texts.slice(before).every((t) => t.to === ALPHA_HUMAN)).toBe(true);
    expect(texts.slice(before).some((t) => t.to === BETA_HUMAN)).toBe(false);
  });

  it("a vendor on one workspace's deal who approves for another: held, not guessed; the deal code decides which role the text plays", async () => {
    const repo = new InMemoryRepository();
    const { engine } = instance(repo);
    const NUM = "+14085550999";
    await workspaces(repo, engine, { ws_alpha: ALPHA_HUMAN, ws_beta: NUM });
    const a = await engine.forWorkspace("ws_alpha").deal({ request, budget_usd, businesses: [{ name: "Teammate Grill", phone: NUM, channel: "imessage" }] });
    const b = await engine.forWorkspace("ws_beta").deal({ request, budget_usd, businesses: [{ name: "Beta Grill", phone: "+14085550222", channel: "imessage" }] });
    expect((await engine.ingestText({ messageId: "n1", from: NUM, text: "$900 total all-in, delivered", inbound: true })).outcome).toBe("ambiguous_workspace");
    const code = (await repo.getJob(a.job_id))!.short_code;
    expect(await engine.ingestText({ messageId: "n2", from: NUM, text: `$900 total all-in, delivered HG-${code}`, inbound: true })).toMatchObject({ jobId: a.job_id, outcome: "stored" });
    expect(await inbound(repo, b.job_id)).toEqual([]);
  });

  it("interleaved emails, calls and texts of two workspaces each land on their own deal only", async () => {
    const repo = new InMemoryRepository();
    const { engine, calls } = instance(repo, { config: { phone: true } as never });
    await workspaces(repo, engine, { ws_alpha: ALPHA_HUMAN, ws_beta: BETA_HUMAN });
    const a = await engine.forWorkspace("ws_alpha").deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }, { name: "Mission Eats", phone: "+14155550104" }, { name: "Alpha Grill", phone: "+14085550111", channel: "imessage" }] });
    const b = await engine.forWorkspace("ws_beta").deal({ request, budget_usd, businesses: [{ name: "Sunset Kitchen", email: "sunset@inkboxmail.test" }, { name: "Quiet Bistro", phone: "+14155550122" }, { name: "Beta Grill", phone: "+14085550222", channel: "imessage" }] });
    const rfq = async (jobId: string, name: string) => (await repo.getBusinesses(jobId)).find((x) => x.name === name)!.rfq_message_id!;
    const mail = async (n: number, jobId: string, name: string, from: string, body: string) => {
      const id = await rfq(jobId, name);
      return engine.ingest({ providerEventId: `e${n}`, eventType: "message.received", providerEmailId: `in_${n}`, threadId: `t${n}`, messageId: `<in_${n}@x>`, inReplyTo: [id], references: [id], from, to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText: body, attachments: [], attachmentsDownloadUrl: null }, trusted);
    };
    const callId = async (jobId: string, to: string) => (await repo.listMessages(jobId)).find((m) => m.kind === "call" && m.to_address === to)?.provider_email_id?.replace(/^call:/, "") ?? null;
    expect(calls.length).toBe(2);
    const steps = [
      () => engine.ingestText({ messageId: "tb", from: "+14085550222", text: "$1,100 total all-in, delivered, $100 deposit", inbound: true }),
      () => mail(1, a.job_id, "Harbor Table", "harbor@inkboxmail.test", "$1,150 total, delivered. $345 deposit."),
      () => engine.ingestText({ messageId: "ta", from: "+14085550111", text: "$1,020 total all-in, delivered, $100 deposit", inbound: true }),
      () => mail(2, b.job_id, "Sunset Kitchen", "sunset@inkboxmail.test", "$1,080 total, delivered. $300 deposit."),
    ];
    const outcomes = [];
    for (const s of steps) outcomes.push(await s());
    expect(outcomes.map((o) => o.jobId)).toEqual([b.job_id, a.job_id, a.job_id, b.job_id]);
    for (const [jobId, ...names] of [[a.job_id, "Harbor Table", "Alpha Grill"], [b.job_id, "Sunset Kitchen", "Beta Grill"]] as const) {
      const bs = await repo.getBusinesses(jobId);
      const from = new Set((await inbound(repo, jobId)).map((m) => bs.find((x) => x.business_id === m.business_id)?.name));
      expect([...from].sort()).toEqual([...names].sort());
    }
    // A call ended event is matched by the call Haggle placed, never by number across workspaces.
    const mission = await callId(a.job_id, "+14155550104");
    if (mission) {
      expect((await engine.ingestCall({ callId: mission, outcome: "completed", transcript: "Mission Eats: $990 total, delivered." })).jobId).toBe(a.job_id);
      expect((await inbound(repo, b.job_id)).some((m) => m.provider_email_id === `call-ended:${mission}`)).toBe(false);
    }
  });

  it("the agent's tools refuse another workspace's job, quote, question, business and approval ids, and show no other workspace's learning", async () => {
    const repo = new InMemoryRepository();
    const { engine } = instance(repo);
    await workspaces(repo, engine, { ws_alpha: ALPHA_HUMAN, ws_beta: BETA_HUMAN });
    const alpha = engine.forWorkspace("ws_alpha");
    const beta = engine.forWorkspace("ws_beta");
    const d = await alpha.deal({ request, budget_usd, businesses: [{ name: "Alpha Grill", phone: "+14085550111", channel: "imessage" }] });
    await engine.ingestText({ messageId: "q", from: "+14085550111", text: "Do you need plates? Prefer text replies please.", inbound: true });
    await engine.advanceJob(d.job_id);
    await engine.ingestText({ messageId: "p", from: "+14085550111", text: "$1,020 total all-in, delivered, $100 deposit", inbound: true });
    await engine.advanceJob(d.job_id);
    const board = await alpha.getQuotes(d.job_id);
    const quote = board.quotes[0]!;
    const biz = (await repo.getBusinesses(d.job_id))[0]!;
    const question = (await repo.listQuestions(d.job_id))[0]!;
    const approval = (await repo.getLatestApproval(d.job_id))?.status === "pending" ? (await repo.getLatestApproval(d.job_id))! : await alpha.requestApproval(d.job_id, quote.quote_id, "view", undefined, { text: true });
    const job = d.job_id;
    const attempts: [string, () => Promise<unknown>][] = [
      ["loadJob", () => beta.loadJob(job)], ["waitForUpdate", () => beta.waitForUpdate(job, 0, 0)], ["getQuotes", () => beta.getQuotes(job)],
      ["answerSeller", () => beta.answerSeller(job, question.id, "x")], ["sendMessage", () => beta.sendMessage(job, biz.business_id, { text: "hi" })],
      ["negotiate", () => beta.negotiate(job)], ["getConversation", () => beta.getConversation(job, biz.business_id)],
      ["requestApproval", () => beta.requestApproval(job, quote.quote_id, "view")], ["pay", () => beta.pay(job, quote.quote_id)], ["cancel", () => beta.cancel(job)],
      ["quoteForCheck", () => beta.quoteForCheck(job, quote.quote_id)], ["approvalCaveats", () => beta.approvalCaveats(job, quote.quote_id)],
      ["callbackProposals", () => beta.callbackProposals(job)], ["placeCallback", () => beta.placeCallback(job, biz.business_id, "human")],
      ["revokeApproval", () => beta.revokeApproval(job, approval.id, "x")], ["advanceJob", () => beta.advanceJob(job)],
      ["approvalById", () => beta.approvalById(approval.id)], ["approvalOffers", () => beta.approvalOffers(approval.id)], ["decideApproval", () => beta.decideApproval(approval.id, "approve", "view", "attacker")],
      ["approveWithViewCode", () => beta.approveWithViewCode(approval.id, approval.code)], ["approvalIMessageSent", () => beta.approvalIMessageSent(approval.id)],
    ];
    for (const [name, call] of attempts) {
      const e = await call().then(() => null, (x: { code?: string; message?: string }) => x);
      expect(e?.code, name).toMatch(/^(job_not_found|approval_not_found)$/);
      expect(e?.message ?? "", name).not.toMatch(/Alpha Grill|1,020/);
    }
    expect((await repo.getApproval(approval.id))!.status).toBe("pending");
    expect((await repo.getJob(job))!.state).not.toBe("cancelled");
    expect((await beta.recentDeals()).map((x) => x.job_id)).not.toContain(job);
    expect(await beta.latestJob()).toBeNull();
    // Learning about the vendor: Alpha sees its replies; Beta sees nothing of Alpha's deal.
    expect((await alpha.contactLearning(biz.business_id)).channels.imessage?.replied_jobs ?? (await alpha.contactLearning(biz.business_id)).channels.phone?.replied_jobs).toBeGreaterThan(0);
    const theirs = await beta.contactLearning(biz.business_id);
    expect(Object.values(theirs.channels).every((c) => !c || c.contacted_jobs === 0)).toBe(true);
    expect(theirs.stated_preference ?? null).toBeNull();
    expect([...(await beta.ownJobIds([job]))]).toEqual([]);
    expect([...(await alpha.ownJobIds([job, "job_nope"]))]).toEqual([job]);
  });
});

describe("text conversations survive restarts and span instances (in memory)", () => {
  it("a bare NO to the approval another instance texted (or one texted before a restart) declines it: the route is durable", async () => {
    const repo = new InMemoryRepository();
    const first = instance(repo);
    await workspaces(repo, first.engine, { ws_alpha: ALPHA_HUMAN });
    const w = first.engine.forWorkspace("ws_alpha");
    const d = await w.deal({ request, budget_usd, businesses: [{ name: "Alpha Grill", phone: "+14085550111", channel: "imessage" }] });
    await first.engine.ingestText({ messageId: "p", from: "+14085550111", text: "$1,020 total all-in, delivered, $100 deposit", inbound: true });
    await first.engine.advanceJob(d.job_id);
    const q = (await w.getQuotes(d.job_id)).quotes[0]!;
    const pending = await repo.getLatestApproval(d.job_id);
    const a = pending?.status === "pending" ? pending : await w.requestApproval(d.job_id, q.quote_id, "view", undefined, { text: true });
    expect(first.texts.some((t) => t.to === ALPHA_HUMAN && t.text.includes(a.code))).toBe(true);
    // A fresh process (restart, or the other replica) gets the reply.
    const second = instance(repo);
    expect(await second.engine.ingestText({ messageId: "y", from: ALPHA_HUMAN, text: "no", inbound: true })).toMatchObject({ jobId: d.job_id, outcome: "declined" });
    expect((await repo.getApproval(a.id))!.status).toBe("declined");
  });

  it("texts held while Inkbox paused the number are re-sent by whichever instance hears back, once", async () => {
    const repo = new InMemoryRepository();
    let blocked = true;
    const sent: Sent[] = [];
    const sms: SmsPort = {
      async send(r) {
        if (blocked && r.to === ALPHA_HUMAN) throw Object.assign(new Error('HTTP 422: {"error":"message_blocked_spam_filter","rule":"unanswered_limit"}'), { statusCode: 422, detail: { error: "message_blocked_spam_filter", rule: "unanswered_limit" } });
        sent.push(r);
        return { messageId: `sms_${sent.length}` };
      },
    };
    const first = instance(repo, { sms });
    await workspaces(repo, first.engine, { ws_alpha: ALPHA_HUMAN });
    const d = await first.engine.forWorkspace("ws_alpha").deal({ request, budget_usd, businesses: [{ name: "Alpha Grill", phone: "+14085550111", channel: "imessage" }] });
    await first.engine.ingestText({ messageId: "q", from: "+14085550111", text: "Do you need plates and cutlery?", inbound: true });
    await first.engine.advanceJob(d.job_id);
    expect(sent.some((t) => t.to === ALPHA_HUMAN)).toBe(false);
    expect((await repo.listEvents(d.job_id)).some((e) => /Texts to you are paused/.test(String(e.data.summary)))).toBe(true);
    // Restart; the human texts back to a fresh instance, which re-sends the held question.
    blocked = false;
    const second = instance(repo, { sms });
    const third = instance(repo, { sms });
    await Promise.all([second.engine.ingestText({ messageId: "r1", from: ALPHA_HUMAN, text: "RESUME", inbound: true }), third.engine.ingestText({ messageId: "r2", from: ALPHA_HUMAN, text: "resume", inbound: true })]);
    expect(sent.filter((t) => t.to === ALPHA_HUMAN && /Alpha Grill asks/.test(t.text))).toHaveLength(1);
    // The re-sent question is what the human's next text answers.
    expect(await second.engine.ingestText({ messageId: "r3", from: ALPHA_HUMAN, text: "Just the food.", inbound: true })).toMatchObject({ jobId: d.job_id, outcome: "answered" });
  });
});

// The same guarantees on Postgres: separate repositories (pools) stand in for separate processes.
const PG_URL = process.env.HAGGLE_TEST_DATABASE_URL;
describe.skipIf(!PG_URL)("workspace isolation on Postgres (two instances)", { timeout: 60_000 }, () => {
  const phone = () => `+1408${String(Math.floor(1_000_000 + Math.random() * 8_999_999))}`;

  it("two instances: a vendor number on two workspaces' deals is held without its code and routed by it; a bare NO after a restart declines", async () => {
    const [p1, p2] = [new PostgresRepository(PG_URL!), new PostgresRepository(PG_URL!)];
    try {
      const one = instance(p1);
      const two = instance(p2);
      const [wa, wb] = [`ws_ta_${uniq()}`, `ws_tb_${uniq()}`];
      const [ha, hb, grill] = [phone(), phone(), phone()];
      await workspaces(p1, one.engine, { [wa]: ha, [wb]: hb });
      const a = await one.engine.forWorkspace(wa).deal({ request, budget_usd, businesses: [{ name: "Golden Grill", phone: grill, channel: "imessage" }] });
      const b = await two.engine.forWorkspace(wb).deal({ request, budget_usd, businesses: [{ name: "Golden Grill", phone: grill, channel: "imessage" }] });
      expect((await two.engine.ingestText({ messageId: `g_${uniq()}`, from: grill, text: "$1,020 total all-in, delivered, $100 deposit", inbound: true })).outcome).toBe("ambiguous_workspace");
      expect(await inbound(p1, a.job_id)).toEqual([]);
      const code = (await p1.getJob(a.job_id))!.short_code;
      expect(await one.engine.ingestText({ messageId: `g_${uniq()}`, from: grill, text: `HG-${code} $1,020 total all-in, delivered, $100 deposit`, inbound: true })).toMatchObject({ jobId: a.job_id, outcome: "stored" });
      expect(await inbound(p2, b.job_id)).toEqual([]);
      await one.engine.advanceJob(a.job_id);
      const w = one.engine.forWorkspace(wa);
      const q = (await w.getQuotes(a.job_id)).quotes[0]!;
      const pending = await p1.getLatestApproval(a.job_id);
      const ap = pending?.status === "pending" ? pending : await w.requestApproval(a.job_id, q.quote_id, "view", undefined, { text: true });
      expect(one.texts.some((t) => t.to === ha && t.text.includes(ap.code))).toBe(true);
      // The other instance, which never texted, routes the human's bare NO through text_routes.
      const restarted = instance(new PostgresRepository(PG_URL!));
      expect(await restarted.engine.ingestText({ messageId: `y_${uniq()}`, from: ha, text: "No", inbound: true })).toMatchObject({ jobId: a.job_id, outcome: "declined" });
      expect((await p2.getApproval(ap.id))!.status).toBe("declined");
      expect((await p2.getApproval(ap.id))!.approver).toBe(ha);
    } finally {
      await Promise.all([p1.close(), p2.close()]);
    }
  });

  it("held texts are taken by exactly one instance; text_routes can't point at another workspace's job; a suppression removal is recorded", async () => {
    const [p1, p2] = [new PostgresRepository(PG_URL!), new PostgresRepository(PG_URL!)];
    try {
      const one = instance(p1);
      const [wa, wb] = [`ws_ta_${uniq()}`, `ws_tb_${uniq()}`];
      const ha = phone();
      await workspaces(p1, one.engine, { [wa]: ha, [wb]: phone() });
      const a = await one.engine.forWorkspace(wa).deal({ request, budget_usd, businesses: [{ name: "Alpha Grill", phone: phone(), channel: "imessage" }] });
      for (const k of ["k1", "k2", "k3", "k4"]) await p1.holdText({ line: "default", remote: ha, key: k, workspace_id: wa, job_id: a.job_id, text: `held ${k}`, question_id: null, approval_id: null }, 3);
      const [x, y] = await Promise.all([p1.takeHeldTexts("default", ha), p2.takeHeldTexts("default", ha)]);
      expect([...x, ...y].map((h) => h.key).sort()).toEqual(["k2", "k3", "k4"]);
      await expect(p1.recordTextRoute({ line: "default", remote: ha, workspace_id: wb, job_id: a.job_id, purpose: "human", business_id: null, question_id: null, approval_id: null, last_out_at: new Date().toISOString() })).rejects.toThrow(/workspace/);
      const contact = `wrong-${uniq()}@inkboxmail.test`;
      await p1.addSuppression({ contact, reason: "bounce", job_id: a.job_id, evidence: "mailbox full" });
      expect(await p2.removeSuppression(contact, "operator (test)", "a full mailbox is not a hard bounce")).toMatchObject({ contact, reason: "bounce", removed_by: "operator (test)" });
      expect(await p1.findSuppressions([contact])).toEqual([]);
      expect(await p1.removeSuppression(contact, "operator (test)", "again")).toBeNull();
      expect(await p1.listWorkspacesByApproverPhone(ha)).toEqual([wa]);
    } finally {
      await Promise.all([p1.close(), p2.close()]);
    }
  });
});
