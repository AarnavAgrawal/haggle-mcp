// Sprint 4, workstream D: multi-tenant security and transaction integrity. Adversarial: every case
// here is an attempt by a model-only caller, a client-side board/form, another workspace, or a
// spoofed sender to place a real call, approve, pay or read across tenants. Real engine, fake ports,
// a fake clock; no network.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, type EngineConfig } from "../src/index.ts";
import { simulatedStripe, type StripePort } from "../src/payments/stripe.ts";
import { CALL_TEXT, callbackConsent, pendingCallbackAuths } from "../src/workflow/callbackAuth.ts";
import { transition } from "../src/workflow/stateMachine.ts";
import type { Repository } from "../src/store/types.ts";

const ALPHA_HUMAN = "+14155550101";
const BETA_HUMAN = "+14155550202";
const MISSION = "+14155550104";
const { budget_usd, ...request } = GOLDEN_REQUEST;

// Reads figures out of free text, like the Claude extractor does live.
const textExtractor = {
  async extract(i: { bodyText: string }) {
    const t = (i.bodyText.split("[The business's reply]:")[1] ?? i.bodyText);
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

function setup(config: Partial<EngineConfig> = {}, opts: { repo?: Repository; stripe?: StripePort } = {}) {
  let t = Date.now();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const emails: { to: string; subject: string; bodyText: string }[] = [];
  const texts: { to: string; text: string; idempotencyKey: string }[] = [];
  const calls: { toNumber: string; reason: string; idempotencyKey?: string }[] = [];
  const repo = (opts.repo ?? new InMemoryRepository()) as InMemoryRepository;
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor: textExtractor as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    ...(opts.stripe ? { stripe: opts.stripe } : {}),
    email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${emails.length}_${Math.random().toString(36).slice(2, 8)}@haggle.test>` }; } },
    sms: { async send(r) { texts.push(r); return { messageId: `sms_${texts.length}` }; } },
    phone: { async placeCall(r) { calls.push(r as never); return { callId: `call_${calls.length}` }; } },
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 500_000, maxRounds: 2, ...config,
    },
  });
  return { engine, repo, clock, emails, texts, calls };
}
type Env = ReturnType<typeof setup>;

async function workspace(env: Env, id: string, approver: string) {
  if (!(await env.repo.getWorkspace(id))) await env.repo.insertWorkspace({ id, name: id, token_hash: null, connector_secret_hash: null, timezone: "America/Los_Angeles" });
  await env.engine.updateSettings({ approver_phone: approver, spending_cap_cents: 500_000 }, id, "operator");
}

let n = 0;
/**
 * A deal where a phone vendor (Mission Eats) quoted $1,150 on its call and an email vendor quoted a
 * real, cheaper $1,080: one callback to Mission Eats is justified. A third vendor that never answers
 * keeps collection open (the automatic counter round hasn't run).
 */
async function justifiedCallback(env: Env, ws = "ws_alpha", phone = MISSION) {
  const w = env.engine.forWorkspace(ws);
  const harbor = `harbor-${++n}@inkboxmail.test`;
  const deal = await w.deal({ request, budget_usd, max_rounds: 2, businesses: [{ name: "Harbor Table", email: harbor }, { name: "Mission Eats", phone }, { name: "Quiet Bistro", email: `quiet-${n}@inkboxmail.test` }] });
  const bs = await env.repo.getBusinesses(deal.job_id);
  const rfq = bs.find((b) => b.name === "Harbor Table")!.rfq_message_id!;
  await env.engine.ingest({ providerEventId: `e${n}`, eventType: "message.received", providerEmailId: `in_${n}`, threadId: `t${n}`, messageId: `<in_${n}@x>`, inReplyTo: [rfq], references: [rfq], from: harbor, to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText: "$1,080 total, 12 vegetarian, delivered. $300 deposit.", attachments: [], attachmentsDownloadUrl: null }, trusted);
  const placed = (await env.repo.listMessages(deal.job_id)).find((m) => m.kind === "call" && m.direction === "out")!;
  expect((await env.engine.ingestCall({ callId: placed.provider_email_id!, outcome: "completed", transcript: "haggle: I'm an AI assistant...\nremote: For you, $1,150 total all-in, 12 vegetarian, delivery included, $150 deposit." })).outcome).toBe("stored");
  await env.engine.advanceJob(deal.job_id);
  const mission = bs.find((b) => b.name === "Mission Eats")!;
  expect((await w.callbackProposals(deal.job_id)).map((p) => p.business_id)).toEqual([mission.business_id]);
  return { w, jobId: deal.job_id, mission, callsBefore: env.calls.length };
}

const consent = (env: Env, ws: string, phone = MISSION) => env.engine.addWorkspaceVendor({ workspace_id: ws, contact: phone, name: "Mission Eats", consent: "Owner agreed by phone to AI calls, 2026-10-20", added_by: "operator@test" });
const codeIn = (text: string) => /CALL (\d{6})/.exec(text)?.[1] ?? null;

// ───────────────────────────── call_back authorization ─────────────────────────────

describe("callback authorization: only the approver's coded text or an operator places a real call", () => {
  it("in live mode no tool path places a call: the client form / board tap / model's authorizedBy is refused", async () => {
    const env = setup();
    await workspace(env, "ws_alpha", ALPHA_HUMAN);
    await consent(env, "ws_alpha");
    const { w, jobId, mission, callsBefore } = await justifiedCallback(env);
    for (const by of ["mcp-client:claude-code", "human tap on the deal board", "DEMO simulated human"]) {
      await expect(w.placeCallback(jobId, mission.business_id, by)).rejects.toMatchObject({ code: "callback_needs_approver_text" });
    }
    expect(env.calls).toHaveLength(callsBefore);
  });

  it("the request texts the approver a one-time code (never returned, never stored in clear); CALL <code> from the approver places exactly one call", async () => {
    const env = setup();
    await workspace(env, "ws_alpha", ALPHA_HUMAN);
    await consent(env, "ws_alpha");
    const { w, jobId, mission, callsBefore } = await justifiedCallback(env);
    const r = await w.requestCallbackAuthorization(jobId, mission.business_id);
    expect(r).toMatchObject({ texted: true, proposal: { business: "Mission Eats", basis_total_usd: 1080 } });
    expect(env.calls).toHaveLength(callsBefore);
    const sms = env.texts.filter((t) => t.to === ALPHA_HUMAN).at(-1)!;
    const code = codeIn(sms.text)!;
    expect(code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(r)).not.toContain(code);
    expect(JSON.stringify(await env.repo.listEvents(jobId))).not.toContain(code);
    expect(JSON.stringify(await w.getQuotes(jobId))).not.toContain(code);

    expect(await env.engine.ingestText({ messageId: "c1", from: ALPHA_HUMAN, text: `CALL ${code}`, inbound: true })).toMatchObject({ jobId, outcome: "callback_placed" });
    expect(env.calls).toHaveLength(callsBefore + 1);
    expect(env.calls.at(-1)).toMatchObject({ toNumber: MISSION });
    expect(env.calls.at(-1)!.reason).toMatch(/AI assistant/);
    const counter = (await env.repo.listEvents(jobId)).find((e) => e.type === "counteroffer" && e.data.channel === "phone")!;
    expect(String(counter.data.authorized_by)).toMatch(/^approver-text:/);
    // Replayed webhook, and the same code again: still one call.
    expect((await env.engine.ingestText({ messageId: "c1", from: ALPHA_HUMAN, text: `CALL ${code}`, inbound: true })).outcome).toBe("duplicate");
    expect((await env.engine.ingestText({ messageId: "c2", from: ALPHA_HUMAN, text: `CALL ${code}`, inbound: true })).outcome).toBe("callback_no_match");
    expect(env.calls).toHaveLength(callsBefore + 1);
  });

  it("the code from any other number (the vendor, another workspace's approver) places nothing", async () => {
    const env = setup();
    await workspace(env, "ws_alpha", ALPHA_HUMAN);
    await workspace(env, "ws_beta", BETA_HUMAN);
    await consent(env, "ws_alpha");
    const { w, jobId, mission, callsBefore } = await justifiedCallback(env);
    await w.requestCallbackAuthorization(jobId, mission.business_id);
    const code = codeIn(env.texts.filter((t) => t.to === ALPHA_HUMAN).at(-1)!.text)!;
    await env.engine.forWorkspace("ws_beta").deal({ request, budget_usd, businesses: [{ name: "Beta Grill", email: "beta-grill@inkboxmail.test" }] });
    await env.engine.ingestText({ messageId: "x1", from: BETA_HUMAN, text: `CALL ${code}`, inbound: true });
    await env.engine.ingestText({ messageId: "x2", from: MISSION, text: `CALL ${code}`, inbound: true });
    await env.engine.ingestText({ messageId: "x3", from: "+14155550999", text: `CALL ${code}`, inbound: true });
    expect(env.calls).toHaveLength(callsBefore);
    expect(pendingCallbackAuths(await env.repo.listEvents(jobId), env.clock.now())).toHaveLength(1);
  });

  it("wrong codes lock the callback after 5; an expired code places nothing", async () => {
    const env = setup();
    await workspace(env, "ws_alpha", ALPHA_HUMAN);
    await consent(env, "ws_alpha");
    const { w, jobId, mission, callsBefore } = await justifiedCallback(env);
    await w.requestCallbackAuthorization(jobId, mission.business_id);
    const code = codeIn(env.texts.filter((t) => t.to === ALPHA_HUMAN).at(-1)!.text)!;
    const wrong = code === "111111" ? "222222" : "111111";
    for (let i = 0; i < 5; i++) expect((await env.engine.ingestText({ messageId: `w${i}`, from: ALPHA_HUMAN, text: `CALL ${wrong}`, inbound: true })).outcome).toBe("callback_no_match");
    expect((await env.engine.ingestText({ messageId: "w9", from: ALPHA_HUMAN, text: `CALL ${code}`, inbound: true })).outcome).toBe("callback_no_match");
    expect(env.calls).toHaveLength(callsBefore);

    await w.requestCallbackAuthorization(jobId, mission.business_id);
    const fresh = codeIn(env.texts.filter((t) => t.to === ALPHA_HUMAN && /CALL \d{6}/.test(t.text)).at(-1)!.text)!;
    env.clock.advance(31 * 60_000);
    expect((await env.engine.ingestText({ messageId: "late", from: ALPHA_HUMAN, text: `CALL ${fresh}`, inbound: true })).outcome).toBe("callback_no_match");
    expect(env.calls).toHaveLength(callsBefore);
  });

  it("consent: no recorded consent refuses the request; an operator-authorized vendor or a business that called Haggle may be called", async () => {
    const env = setup();
    await workspace(env, "ws_alpha", ALPHA_HUMAN);
    const { w, jobId, mission, callsBefore } = await justifiedCallback(env);
    await expect(w.requestCallbackAuthorization(jobId, mission.business_id)).rejects.toMatchObject({ code: "callback_no_consent" });
    await expect(env.engine.operatorCallback(jobId, mission.business_id, "ops-alice")).rejects.toMatchObject({ code: "callback_no_consent" });
    expect(env.texts.some((t) => /CALL \d{6}/.test(t.text))).toBe(false);
    // Consent recorded for another workspace isn't this one's.
    await workspace(env, "ws_beta", BETA_HUMAN);
    await consent(env, "ws_beta");
    await expect(w.requestCallbackAuthorization(jobId, mission.business_id)).rejects.toMatchObject({ code: "callback_no_consent" });
    // The business itself called Haggle on this deal (inbound call from its pinned number).
    expect((await env.engine.ingestCall({ callId: "in_call_1", outcome: "completed", transcript: "remote: Hi, it's Mission Eats calling back about the quote.", direction: "inbound", remoteNumber: MISSION })).jobId).toBe(jobId);
    expect(await env.engine.callbackConsentFor(jobId, mission.business_id)).toEqual({ ok: true, basis: "called_us" });
    expect((await env.engine.operatorCallback(jobId, mission.business_id, "ops-alice")).placed).toBe(true);
    expect(env.calls).toHaveLength(callsBefore + 1);
    expect(String((await env.repo.listEvents(jobId)).find((e) => e.type === "counteroffer" && e.data.channel === "phone")!.data.authorized_by)).toBe("operator:ops-alice");
  });

  it("never to a suppressed number, even with consent and the approver's code", async () => {
    const env = setup();
    await workspace(env, "ws_alpha", ALPHA_HUMAN);
    await consent(env, "ws_alpha");
    const { w, jobId, mission, callsBefore } = await justifiedCallback(env);
    await w.requestCallbackAuthorization(jobId, mission.business_id);
    const code = codeIn(env.texts.filter((t) => t.to === ALPHA_HUMAN).at(-1)!.text)!;
    await env.repo.addSuppression({ contact: MISSION, reason: "opt_out", job_id: null, evidence: "STOP" });
    expect((await env.engine.ingestText({ messageId: "s1", from: ALPHA_HUMAN, text: `CALL ${code}`, inbound: true })).outcome).toBe("callback_refused");
    await expect(w.requestCallbackAuthorization(jobId, mission.business_id)).rejects.toMatchObject({ code: "callback_no_consent" });
    await expect(env.engine.operatorCallback(jobId, mission.business_id, "ops")).rejects.toMatchObject({ code: "callback_no_consent" });
    expect(env.calls).toHaveLength(callsBefore);
  });

  it("DEMO (mock, in-band approvals) keeps the form/board path; a live server never does", async () => {
    const env = setup({ mode: "mock", outOfBandApprovalsOnly: false, callCooldownMs: 0 });
    await workspace(env, "ws_alpha", ALPHA_HUMAN);
    const { w, jobId, mission, callsBefore } = await justifiedCallback(env);
    expect(w.callbacksNeedApproverText).toBe(false);
    expect((await w.placeCallback(jobId, mission.business_id, "mcp-client:test")).placed).toBe(true);
    expect(env.calls).toHaveLength(callsBefore + 1);
    expect(setup({ mode: "mock", outOfBandApprovalsOnly: true }).engine.callbacksNeedApproverText).toBe(true);
    expect(setup({ mode: "live", outOfBandApprovalsOnly: false }).engine.callbacksNeedApproverText).toBe(true);
  });

  it("another workspace can't request, place or see a callback on the deal", async () => {
    const env = setup();
    await workspace(env, "ws_alpha", ALPHA_HUMAN);
    await workspace(env, "ws_beta", BETA_HUMAN);
    await consent(env, "ws_alpha");
    const { jobId, mission } = await justifiedCallback(env);
    const beta = env.engine.forWorkspace("ws_beta");
    await expect(beta.requestCallbackAuthorization(jobId, mission.business_id)).rejects.toMatchObject({ code: "job_not_found" });
    await expect(beta.placeCallback(jobId, mission.business_id, "x")).rejects.toMatchObject({ code: "job_not_found" });
    await expect(beta.callbackProposals(jobId)).rejects.toMatchObject({ code: "job_not_found" });
    expect(env.texts.some((t) => t.to === BETA_HUMAN)).toBe(false);
  });

  it("pure rules: CALL needs six digits; consent from durable records only", () => {
    expect(CALL_TEXT.exec("call 123456")?.[1]).toBe("123456");
    expect(CALL_TEXT.exec("CALL 1234")).toBeNull();
    expect(CALL_TEXT.exec("please call 123456 now")).toBeNull();
    const b = { business_id: "b1", phone: MISSION, simulated: false, status: "quoted" as const };
    expect(callbackConsent({ business: b, workspaceVendors: [], messages: [], suppressed: false }).ok).toBe(false);
    expect(callbackConsent({ business: b, workspaceVendors: [{ contact: MISSION, consent: "ok by phone" }], messages: [], suppressed: false })).toEqual({ ok: true, basis: "workspace_vendor" });
    expect(callbackConsent({ business: b, workspaceVendors: [{ contact: MISSION, consent: "ok by phone" }], messages: [], suppressed: true }).ok).toBe(false);
    // A caller-ID match on another business, or an outbound call, isn't the business calling us.
    expect(callbackConsent({ business: b, workspaceVendors: [], messages: [{ direction: "out", business_id: "b1", channel: "phone", matched_via: null, from_address: null }], suppressed: false }).ok).toBe(false);
    expect(callbackConsent({ business: { ...b, simulated: true }, workspaceVendors: [], messages: [], suppressed: false })).toEqual({ ok: true, basis: "simulated_vendor" });
  });
});

// ───────────────────────────── money in flight ─────────────────────────────

describe("a Stripe `charging` row is money in flight: cancel and approval-void can't slip through", () => {
  async function charging() {
    const env = setup({ notifyPhone: ALPHA_HUMAN }, { stripe: simulatedStripe() });
    const harbor = "harbor-charge@inkboxmail.test";
    const deal = await env.engine.deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: harbor }] });
    const b = (await env.repo.getBusinesses(deal.job_id))[0]!;
    await env.engine.ingest({ providerEventId: "ec", eventType: "message.received", providerEmailId: "in_c", threadId: "tc", messageId: "<in_c@x>", inReplyTo: [b.rfq_message_id!], references: [b.rfq_message_id!], from: harbor, to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText: "$1,150 total, delivered. $345 deposit.", attachments: [], attachmentsDownloadUrl: null }, trusted);
    await env.engine.advanceJob(deal.job_id);
    const q = (await env.engine.getQuotes(deal.job_id)).quotes[0]!;
    const pending = await env.repo.getLatestApproval(deal.job_id);
    const a = pending?.status === "pending" ? pending : await env.engine.requestApproval(deal.job_id, q.quote_id, "imessage");
    expect((await env.engine.ingestText({ messageId: `yes_${a.id}`, from: ALPHA_HUMAN, text: `YES ${a.code}`, inbound: true })).outcome).toBe("approved");
    expect((await env.repo.getJob(deal.job_id))!.state).toBe("paying");
    await env.repo.insertPayment({ id: `pay_${a.id}`, job_id: deal.job_id, approval_id: a.id, business_id: q.business_id, status: "charging", rail: "stripe", amount_cents: a.payment_cents, amount_base_units: String(a.payment_cents), network: "stripe-test", idempotency_key: `haggle-pay-${a.id}`, stripe_payment_intent_id: null, challenge_json: null, challenge_step_id: null, challenge_message_id: null, challenge_trusted: false, challenge_thread_matched: false, pay_to: null, interaction_json: null, settle_tx: null, simulated: true, reason: null } as never);
    return { env, jobId: deal.job_id, a };
  }

  it("cancel during `charging` is refused (the charge resolves first); the job stays paying", async () => {
    const { env, jobId } = await charging();
    await expect(env.engine.cancel(jobId)).rejects.toMatchObject({ code: "cannot_cancel" });
    expect((await env.repo.getJob(jobId))!.state).toBe("paying");
  });

  it("the state machine: cancelled / approval_void are rejected in paying while a payment is in flight", () => {
    const s = { state: "paying" as const, round: 1, max_rounds: 2, collect_until: new Date().toISOString(), ready: true, failure_reason: null };
    const ctx = { now: new Date(), eligibleQuotes: 1, counterable: false, negotiationWindowMs: 1, paymentInFlight: true };
    expect(transition(s, { type: "cancelled" }, ctx).ok).toBe(false);
    expect(transition(s, { type: "approval_void" }, ctx).ok).toBe(false);
  });
});
