// Sprint 5 B: what account suspension, credential revocation, deal cancellation and the operator's
// reviewed requests (job-ops callback, quarantine release-text) actually do across the tools and
// in-flight jobs. Real engine, in-memory store, fake providers and a fake clock; no network.
//
// Designs verified here:
//   suspension  tools refuse (WORKSPACE_SUSPENDED) while credentials still resolve; every open deal is
//               held and the engine refuses to advance any deal of the workspace even without its
//               hold, so no RFQ, follow-up, counter or deadline close goes out; inbound replies are
//               stored but not read into the deal until resume; resume lifts only the suspension's holds.
//   revocation  the old token and connector URL fail on the very next request.
//   cancel      a cancelled deal sends nothing more, can't be approved, and a YES text doesn't approve it.
//   requests    the CLI records a request; the job's next advance performs it through the engine's own
//               checks (consent, a justified proposal; a decision text is never routed) and records the outcome.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, holdSubject, InMemoryRepository, requestOperatorCallback, requestTextRelease, resumeWorkspace, StubBrain, suspendWorkspace, type EngineConfig, type Repository } from "@haggle/engine";
import { suspensionRefusal } from "../src/operatorGate.ts";
import { hashSecret, newSecret, resolveWorkspace } from "../src/workspace.ts";
import { planAdmin, runAdmin } from "../scripts/workspace-admin.ts";

const HUMAN = "+14155550101";
const OTHER_HUMAN = "+14155550202";
const MISSION = "+14155550104";
const { budget_usd, ...request } = GOLDEN_REQUEST;
const uniq = () => Math.random().toString(36).slice(2, 8);

const textExtractor = {
  async extract(i: { bodyText: string }) {
    const t = i.bodyText.split("[The business's reply]:")[1] ?? i.bodyText;
    const money = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
    const total = money(/\$?\s?([\d,]+(?:\.\d{2})?)\s*(?:total|all[- ]in)/i);
    const deposit = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*deposit/i);
    return {
      available: true, price_per_head_usd: null, headcount: 40, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true,
      total_usd: total, deposit_usd: deposit, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }],
      valid_until: null, questions: [], payment_request: "none" as const, instructions_to_agent: false,
      sources: [...(total !== null ? [{ field: "total" as const, source: "text", excerpt: `$${total} total` }] : []), ...(deposit !== null ? [{ field: "deposit" as const, source: "text", excerpt: `$${deposit} deposit` }] : [])],
      missing_fields: total === null ? ["total" as const] : [], confidence: 0.9,
    };
  },
};
const trusted = (expected: string) => ({ trusted: true as const, address: expected, reason: "trusted" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });

function setup(config: Partial<EngineConfig> = {}) {
  let t = Date.parse("2026-10-22T17:00:00Z");
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const emails: { to: string; subject: string; bodyText: string }[] = [];
  const texts: { to: string; text: string }[] = [];
  const calls: { toNumber: string; reason: string }[] = [];
  const logs: string[] = [];
  const repo = new InMemoryRepository();
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor: textExtractor as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${emails.length}_${uniq()}@haggle.test>` }; } },
    sms: { async send(r) { texts.push(r); return { messageId: `sms_${texts.length}` }; } },
    phone: { async placeCall(r) { calls.push(r as never); return { callId: `call_${calls.length}_${uniq()}` }; } },
    log: (event) => logs.push(event),
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 500_000, maxRounds: 2, manualPaymentHandoff: true, ...config,
    },
  });
  return { engine, repo, clock, emails, texts, calls, logs };
}
type Env = ReturnType<typeof setup>;

async function workspace(env: Env, id: string, approver: string) {
  const token = newSecret("hgw");
  await env.repo.insertWorkspace({ id, name: id, token_hash: hashSecret(token), connector_secret_hash: null, timezone: "America/Los_Angeles" });
  await env.engine.updateSettings({ approver_phone: approver, spending_cap_cents: 500_000 }, id, "operator");
  return token;
}

const toVendors = (env: Env, addrs: string[]) => env.emails.filter((e) => addrs.includes(e.to)).length;

describe("suspension: tools refuse, in-flight deals stop, replies are kept, resume carries on", () => {
  it("a suspended workspace's tools get WORKSPACE_SUSPENDED; another workspace is unaffected; credentials still resolve", async () => {
    const env = setup();
    const token = await workspace(env, "ws_susp", HUMAN);
    await workspace(env, "ws_fine", OTHER_HUMAN);
    const rt = { engine: env.engine };
    expect(await suspensionRefusal(rt, "ws_susp")).toBeNull();
    await suspendWorkspace(env.repo, { workspaceId: "ws_susp", by: "ops-yash", reason: "customer asked to pause the pilot", now: env.clock.now().toISOString() });
    const refused = await suspensionRefusal(rt, "ws_susp");
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "WORKSPACE_SUSPENDED", fix: expect.stringMatching(/operator/) } } });
    expect(JSON.stringify(refused)).not.toMatch(/ops-yash|customer asked/); // the agent sees why, not the operator's notes
    expect(await suspensionRefusal(rt, "ws_fine")).toBeNull();
    expect(await resolveWorkspace(rt as never, { authorization: `Bearer ${token}` }, true)).toMatchObject({ ok: true, workspaceId: "ws_susp" });
    await expect(suspendWorkspace(env.repo, { workspaceId: "ws_susp", by: "ops", reason: "again", now: env.clock.now().toISOString() })).rejects.toThrow(/already suspended/);
    // An unreadable status fails closed.
    const broken = { engine: { workspaceSuspension: async () => { throw new Error("db down"); } } };
    expect(await suspensionRefusal(broken as never, "ws_susp")).toMatchObject({ status: 503 });
  });

  it("open deals: no follow-ups or closes while suspended, even with the hold lifted by hand; a reply is stored, read only after resume", async () => {
    const env = setup();
    await workspace(env, "ws_susp", HUMAN);
    const [a, b] = [`harbor-${uniq()}@inkboxmail.test`, `sunset-${uniq()}@inkboxmail.test`];
    const w = env.engine.forWorkspace("ws_susp");
    const d = await w.deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: a }, { name: "Sunset Kitchen", email: b }] });
    await env.engine.advanceJob(d.job_id);
    const rfqs = toVendors(env, [a, b]);
    expect(rfqs).toBe(2);
    const r = await suspendWorkspace(env.repo, { workspaceId: "ws_susp", by: "ops-yash", reason: "pause", now: env.clock.now().toISOString() });
    expect(r.held).toEqual([d.job_id]);
    expect(await env.repo.findOpenReview("stuck_job", holdSubject(d.job_id))).toMatchObject({ reason: expect.stringMatching(/^workspace suspended by ops-yash/) });

    // A reply arrives while suspended: stored, not read into the deal.
    const harbor = (await env.repo.getBusinesses(d.job_id)).find((x) => x.email === a)!;
    const rfq = harbor.rfq_message_id!;
    const res = await env.engine.ingest({ providerEventId: `e_${uniq()}`, eventType: "message.received", providerEmailId: `in_${uniq()}`, threadId: "t1", messageId: `<in_${uniq()}@x>`, inReplyTo: [rfq], references: [rfq], from: a, to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText: "$1,150 total, delivered. $345 deposit.", attachments: [], attachmentsDownloadUrl: null }, trusted);
    expect(res.jobId).toBe(d.job_id);
    expect((await env.repo.listMessages(d.job_id)).some((m) => m.direction === "in" && m.from_address === a)).toBe(true);

    // Hours pass: follow-ups and the collection deadline would fire; nothing goes out, nothing closes.
    for (let i = 0; i < 6; i++) {
      env.clock.advance(60 * 60_000);
      await env.engine.advanceAllOpen();
      await env.engine.recoverStuck();
    }
    expect(toVendors(env, [a, b])).toBe(rfqs);
    expect((await env.repo.getJob(d.job_id))!.state).toBe("collecting");
    expect(await env.repo.listQuotes(d.job_id)).toEqual([]);

    // The engine refuses a suspended workspace's deal even when its hold is lifted (job-ops resume).
    const hold = (await env.repo.findOpenReview("stuck_job", holdSubject(d.job_id)))!;
    await env.repo.resolveReview(hold.id, { resolution: "operator resumed one job by mistake", resolved_by: "ops" }, env.clock.now().toISOString());
    await env.engine.advanceJob(d.job_id);
    expect(env.logs).toContain("advance_suspended");
    expect(toVendors(env, [a, b])).toBe(rfqs);
    expect(await env.repo.listQuotes(d.job_id)).toEqual([]);

    // Resume: the reply is read; the deal carries on from where it is.
    await env.repo.openReview({ id: `rev_${uniq()}`, job_id: d.job_id, kind: "stuck_job", subject: holdSubject(d.job_id), reason: "workspace suspended by ops-yash: pause", attempts: 0, last_error: null }, env.clock.now().toISOString());
    const back = await resumeWorkspace(env.repo, { workspaceId: "ws_susp", by: "ops-yash", reason: "customer ready", now: env.clock.now().toISOString() });
    expect(back.resumed).toEqual([d.job_id]);
    await env.engine.advanceJob(d.job_id);
    expect((await env.repo.listQuotes(d.job_id)).map((q) => q.total_cents)).toContain(115_000);
  });

  it("resume lifts only the suspension's holds: a job the operator held separately stays held", async () => {
    const env = setup();
    await workspace(env, "ws_susp", HUMAN);
    const w = env.engine.forWorkspace("ws_susp");
    const d1 = await w.deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: `h-${uniq()}@inkboxmail.test` }] });
    const d2 = await w.deal({ request, budget_usd, businesses: [{ name: "Sunset Kitchen", email: `s-${uniq()}@inkboxmail.test` }] });
    await env.repo.openReview({ id: `rev_${uniq()}`, job_id: d2.job_id, kind: "stuck_job", subject: holdSubject(d2.job_id), reason: "operator hold by ops: vendor asked to pause", attempts: 0, last_error: null }, env.clock.now().toISOString());
    const s = await suspendWorkspace(env.repo, { workspaceId: "ws_susp", by: "ops", reason: "pause", now: env.clock.now().toISOString() });
    expect(s).toEqual({ held: [d1.job_id], alreadyHeld: [d2.job_id] });
    const r = await resumeWorkspace(env.repo, { workspaceId: "ws_susp", by: "ops", reason: "resume the pilot", now: env.clock.now().toISOString() });
    expect(r).toEqual({ resumed: [d1.job_id], stillHeld: [d2.job_id] });
    expect(await env.repo.findOpenReview("stuck_job", holdSubject(d2.job_id))).not.toBeNull();
  });
});

describe("revocation: credentials fail on the next request", () => {
  it("workspace-admin revoke: the token and connector URL stop resolving at once; rotate issues working new ones", async () => {
    const env = setup();
    const repo = env.repo;
    const token = newSecret("hgw");
    const secret = newSecret("hgc");
    await repo.insertWorkspace({ id: "ws_rev", name: "Rev", token_hash: hashSecret(token), connector_secret_hash: hashSecret(secret), timezone: "America/Los_Angeles" });
    await repo.saveSettings({ spending_cap_cents: 100_000, approver_phone: HUMAN, approver_email: null, default_area: null } as never, "ws_rev");
    const rt = { engine: env.engine } as never;
    expect(await resolveWorkspace(rt, { authorization: `Bearer ${token}` }, true)).toMatchObject({ ok: true });
    await runAdmin(planAdmin(["revoke", "--id", "ws_rev", "--by", "ops-yash", "--reason", "token pasted in a public channel"]), repo);
    expect(await resolveWorkspace(rt, { authorization: `Bearer ${token}` }, true)).toEqual({ ok: false, reason: "unknown_credentials" });
    expect(await resolveWorkspace(rt, { connectorSecret: secret }, true)).toEqual({ ok: false, reason: "unknown_credentials" });
    const out = await runAdmin(planAdmin(["rotate", "--id", "ws_rev", "--by", "ops-yash", "--reason", "new credentials after the leak", "--base-url", "https://haggle.example"]), repo);
    const fresh = /Bearer token:\s+(hgw_\S+)/.exec(out.text)![1]!;
    expect(await resolveWorkspace(rt, { authorization: `Bearer ${fresh}` }, true)).toMatchObject({ ok: true, workspaceId: "ws_rev" });
    expect(await resolveWorkspace(rt, { authorization: `Bearer ${token}` }, true)).toEqual({ ok: false, reason: "unknown_credentials" });
    const log = await repo.listOperatorActions({ workspaceId: "ws_rev" });
    expect(log.map((x) => [x.action, x.operator])).toEqual([["credentials_rotated", "ops-yash"], ["credentials_revoked", "ops-yash"]]);
    expect(JSON.stringify(log)).not.toContain(fresh);
  });
});

describe("cancellation: nothing more goes out, nothing can be approved", () => {
  it("cancel_deal on an in-flight deal: one close-out note to the business that quoted, then no follow-ups; an approval can't start, a YES text approves nothing", async () => {
    const env = setup();
    await workspace(env, "ws_can", HUMAN);
    const [a, b] = [`harbor-${uniq()}@inkboxmail.test`, `sunset-${uniq()}@inkboxmail.test`];
    const w = env.engine.forWorkspace("ws_can");
    const d = await w.deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: a }, { name: "Sunset Kitchen", email: b }] });
    await env.engine.advanceJob(d.job_id);
    const harbor = (await env.repo.getBusinesses(d.job_id)).find((x) => x.email === a)!;
    const rfq = harbor.rfq_message_id!;
    await env.engine.ingest({ providerEventId: `e_${uniq()}`, eventType: "message.received", providerEmailId: `in_${uniq()}`, threadId: "t1", messageId: `<in_${uniq()}@x>`, inReplyTo: [rfq], references: [rfq], from: a, to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText: "$1,150 total, delivered. $345 deposit.", attachments: [], attachmentsDownloadUrl: null }, trusted);
    await env.engine.advanceJob(d.job_id);
    const q = (await w.getQuotes(d.job_id)).quotes[0]!;
    const pending = await w.requestApproval(d.job_id, q.quote_id, "imessage");
    const before = toVendors(env, [a, b]);
    expect(await w.cancel(d.job_id)).toMatchObject({ ok: true, state: "cancelled" });
    await env.engine.advanceAllOpen();
    // The existing design: exactly one close-out note to the business that quoted ("the customer has
    // cancelled ... we won't be moving forward"), none to the one that never replied, then silence.
    const closeOut = env.emails.slice(before).filter((e) => e.to === a || e.to === b);
    expect(closeOut.map((e) => e.to)).toEqual([a]);
    expect(closeOut[0]!.bodyText).toMatch(/cancelled this request, so we won't be moving forward/);
    const after = toVendors(env, [a, b]);
    for (let i = 0; i < 6; i++) {
      env.clock.advance(60 * 60_000);
      await env.engine.advanceAllOpen();
      await env.engine.recoverStuck();
    }
    expect(toVendors(env, [a, b])).toBe(after);
    await expect(w.requestApproval(d.job_id, q.quote_id, "imessage")).rejects.toBeTruthy();
    expect((await env.engine.ingestText({ messageId: `y_${uniq()}`, from: HUMAN, text: `YES ${pending.code}`, inbound: true })).outcome).not.toBe("approved");
    expect((await env.repo.getApproval(pending.id))!.status).not.toBe("approved");
    expect(toVendors(env, [a, b])).toBe(after);
    // The operator's fail-safe close / callback requests on a closed deal are refused.
    expect(await requestOperatorCallback(env.repo, { jobId: d.job_id, businessId: harbor.business_id, by: "ops", reason: "reviewed the quotes", now: env.clock.now().toISOString() })).toMatchObject({ ok: false, reason: expect.stringMatching(/cancelled/) });
  });
});

// A phone vendor (Mission Eats) quoted $1,150 on its call; an email vendor quoted a cheaper $1,080:
// one callback is justified. A third vendor keeps collection open.
async function justifiedCallback(env: Env, ws: string) {
  const w = env.engine.forWorkspace(ws);
  const harbor = `harbor-${uniq()}@inkboxmail.test`;
  const deal = await w.deal({ request, budget_usd, max_rounds: 2, businesses: [{ name: "Harbor Table", email: harbor }, { name: "Mission Eats", phone: MISSION }, { name: "Quiet Bistro", email: `quiet-${uniq()}@inkboxmail.test` }] });
  const bs = await env.repo.getBusinesses(deal.job_id);
  const rfq = bs.find((b) => b.name === "Harbor Table")!.rfq_message_id!;
  await env.engine.ingest({ providerEventId: `e_${uniq()}`, eventType: "message.received", providerEmailId: `in_${uniq()}`, threadId: "t2", messageId: `<in_${uniq()}@x>`, inReplyTo: [rfq], references: [rfq], from: harbor, to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText: "$1,080 total, 12 vegetarian, delivered. $300 deposit.", attachments: [], attachmentsDownloadUrl: null }, trusted);
  const placed = (await env.repo.listMessages(deal.job_id)).find((m) => m.kind === "call" && m.direction === "out")!;
  await env.engine.ingestCall({ callId: placed.provider_email_id!, outcome: "completed", transcript: "haggle: I'm an AI assistant...\nremote: For you, $1,150 total all-in, 12 vegetarian, delivery included, $150 deposit." });
  await env.engine.advanceJob(deal.job_id);
  const mission = bs.find((b) => b.name === "Mission Eats")!;
  expect((await w.callbackProposals(deal.job_id)).map((p) => p.business_id)).toEqual([mission.business_id]);
  return { jobId: deal.job_id, mission, callsBefore: env.calls.length };
}

describe("job-ops callback: a reviewed request the engine performs through its own checks", () => {
  it("refused up front without the callee's recorded consent; with it, the next advance places exactly one call, recorded as the operator's", async () => {
    const env = setup();
    await workspace(env, "ws_cb", HUMAN);
    const { jobId, mission, callsBefore } = await justifiedCallback(env, "ws_cb");
    const ask = () => requestOperatorCallback(env.repo, { jobId, businessId: mission.business_id, by: "ops-yash", reason: "reviewed: cheaper real quote on the deal", now: env.clock.now().toISOString() });
    expect(await ask()).toMatchObject({ ok: false, reason: expect.stringMatching(/no consent to call/) });
    await env.engine.addWorkspaceVendor({ workspace_id: "ws_cb", contact: MISSION, name: "Mission Eats", consent: "Owner agreed by phone to AI calls, 2026-10-20", added_by: "ops" });
    const r = await ask();
    expect(r).toMatchObject({ ok: true });
    expect(await ask()).toMatchObject({ ok: false, reason: expect.stringMatching(/already waiting/) });
    expect(env.calls).toHaveLength(callsBefore); // the script itself never dials
    await env.engine.advanceJob(jobId);
    expect(env.calls).toHaveLength(callsBefore + 1);
    expect(env.calls.at(-1)).toMatchObject({ toNumber: MISSION });
    const events = await env.repo.listEvents(jobId);
    expect(String(events.find((e) => e.type === "counteroffer" && e.data.channel === "phone")!.data.authorized_by)).toBe("operator:ops-yash");
    expect(events.find((e) => e.type === "operator_request_done")!.data).toMatchObject({ outcome: "callback_placed" });
    expect(await env.repo.listReviews({ status: "open", jobId })).toEqual([]);
    await env.engine.advanceJob(jobId);
    expect(env.calls).toHaveLength(callsBefore + 1); // performed once
    expect((await env.repo.listOperatorActions({ jobId }))[0]).toMatchObject({ action: "callback_requested", operator: "ops-yash", workspace_id: "ws_cb" });
  });

  it("a request the engine refuses when it runs (the number opted out meanwhile) is closed with the refusal; nobody is called", async () => {
    const env = setup();
    await workspace(env, "ws_cb2", HUMAN);
    const { jobId, mission, callsBefore } = await justifiedCallback(env, "ws_cb2");
    await env.engine.addWorkspaceVendor({ workspace_id: "ws_cb2", contact: MISSION, name: "Mission Eats", consent: "Owner agreed by phone to AI calls, 2026-10-20", added_by: "ops" });
    expect(await requestOperatorCallback(env.repo, { jobId, businessId: mission.business_id, by: "ops", reason: "reviewed: cheaper real quote on the deal", now: env.clock.now().toISOString() })).toMatchObject({ ok: true });
    await env.repo.addSuppression({ contact: MISSION, reason: "opt_out", job_id: null, evidence: "STOP" });
    await env.engine.advanceJob(jobId);
    expect(env.calls).toHaveLength(callsBefore);
    const done = (await env.repo.listEvents(jobId)).find((e) => e.type === "operator_request_done")!;
    expect(done.data).toMatchObject({ outcome: "refused", code: "callback_no_consent" });
    expect(await env.repo.listReviews({ status: "open", jobId })).toEqual([]);
  });

  it("nothing runs for a suspended workspace's deal", async () => {
    const env = setup();
    await workspace(env, "ws_cb3", HUMAN);
    const { jobId, mission } = await justifiedCallback(env, "ws_cb3");
    await env.engine.addWorkspaceVendor({ workspace_id: "ws_cb3", contact: MISSION, name: "Mission Eats", consent: "Owner agreed by phone to AI calls, 2026-10-20", added_by: "ops" });
    await suspendWorkspace(env.repo, { workspaceId: "ws_cb3", by: "ops", reason: "pause", now: env.clock.now().toISOString() });
    expect(await requestOperatorCallback(env.repo, { jobId, businessId: mission.business_id, by: "ops", reason: "reviewed: cheaper real quote on the deal", now: env.clock.now().toISOString() })).toMatchObject({ ok: false, reason: expect.stringMatching(/hold|suspended/) });
  });
});

describe("quarantine release-text: a held ambiguous text routed by the engine, never a decision", () => {
  async function twoDeals(env: Env) {
    const [wa, wb] = [`ws_ta_${uniq()}`, `ws_tb_${uniq()}`];
    await workspace(env, wa, HUMAN);
    await workspace(env, wb, OTHER_HUMAN);
    const grill = `+1408${String(Math.floor(1_000_000 + Math.random() * 8_999_999))}`;
    const a = await env.engine.forWorkspace(wa).deal({ request, budget_usd, businesses: [{ name: "Golden Grill", phone: grill, channel: "imessage" }] });
    await env.engine.forWorkspace(wb).deal({ request, budget_usd, businesses: [{ name: "Golden Grill", phone: grill, channel: "imessage" }] });
    return { grill, a };
  }
  const held = async (repo: Repository, text: string) => (await repo.listQuarantinedMessages({ limit: 50 })).find((m) => m.quarantine_reason === "ambiguous_workspace" && m.body_text === text)!;

  it("routed to the named open deal on its next advance; the outcome is recorded; a repeat is a no-op (duplicate)", async () => {
    const env = setup();
    const { grill, a } = await twoDeals(env);
    const text = "$1,020 total all-in, delivered, $100 deposit";
    expect((await env.engine.ingestText({ messageId: `g_${uniq()}`, from: grill, text, inbound: true })).outcome).toBe("ambiguous_workspace");
    const m = await held(env.repo, text);
    const r = await requestTextRelease(env.repo, { messageId: m.id, jobId: a.job_id, by: "ops-yash", reason: "phoned Golden Grill: it answers HG deal for ws_ta", now: env.clock.now().toISOString() });
    expect(r).toMatchObject({ ok: true });
    expect((await env.repo.listMessages(a.job_id)).filter((x) => x.direction === "in")).toEqual([]); // nothing until the server runs it
    await env.engine.advanceJob(a.job_id);
    expect((await env.repo.listMessages(a.job_id)).some((x) => x.direction === "in" && (x.body_text ?? "").includes("$1,020"))).toBe(true);
    const done = (await env.repo.listEvents(a.job_id)).find((e) => e.type === "operator_request_done")!;
    expect(done.data.outcome).not.toBe("refused");
    expect(await requestTextRelease(env.repo, { messageId: m.id, jobId: a.job_id, by: "ops", reason: "again, to be sure", now: env.clock.now().toISOString() })).toMatchObject({ ok: true }); // a new review: the engine dedupes
    await env.engine.advanceJob(a.job_id);
    expect((await env.repo.listEvents(a.job_id)).filter((e) => e.type === "operator_request_done").at(-1)!.data).toMatchObject({ outcome: "duplicate" });
  });

  it("an approval / payment / callback reply is never released by an operator: refused when it runs", async () => {
    const env = setup();
    const { grill, a } = await twoDeals(env);
    expect((await env.engine.ingestText({ messageId: `g_${uniq()}`, from: grill, text: "YES 4821", inbound: true })).outcome).toBe("ambiguous_workspace");
    const m = await held(env.repo, "YES 4821");
    expect(await requestTextRelease(env.repo, { messageId: m.id, jobId: a.job_id, by: "ops", reason: "I think it is for this deal", now: env.clock.now().toISOString() })).toMatchObject({ ok: true });
    await env.engine.advanceJob(a.job_id);
    expect((await env.repo.listEvents(a.job_id)).find((e) => e.type === "operator_request_done")!.data).toMatchObject({ outcome: "refused", code: "decision_not_releasable" });
    expect((await env.repo.listMessages(a.job_id)).filter((x) => x.direction === "in")).toEqual([]);
  });

  it("refused up front: not a held text, or a closed deal", async () => {
    const env = setup();
    const { a } = await twoDeals(env);
    expect(await requestTextRelease(env.repo, { messageId: "msg_doesnotexist", jobId: a.job_id, by: "ops", reason: "a reason here", now: env.clock.now().toISOString() })).toMatchObject({ ok: false, reason: expect.stringMatching(/no held ambiguous text/) });
  });
});
