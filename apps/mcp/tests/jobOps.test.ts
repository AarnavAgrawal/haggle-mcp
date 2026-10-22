// scripts/job-ops.ts (operator-only): argument validation, retry planning and its application
// against an in-memory store, with the real engine performing the re-armed action on its next
// advance. Never a real database, provider or payment rail.
import { describe, expect, it } from "vitest";
import { ChannelSendError, disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, planChargeRelease, planOutboxRetry, simulatedStripe, StubBrain, type ExtractorPort, type StripePort } from "@haggle/engine";
import { applySteps, listStuck, planOps, planRetry } from "../scripts/job-ops.ts";

const APPROVER = "+14155550101";
const VENDOR = "harbor@inkboxmail.test";
const { budget_usd, ...request } = GOLDEN_REQUEST;
const extractor: ExtractorPort = {
  async extract() {
    return {
      available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true,
      total_usd: 1150, deposit_usd: 345, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }], valid_until: null, questions: [], payment_request: "none", instructions_to_agent: false,
      sources: [{ field: "total", source: "email body", excerpt: "$1,150 total" }, { field: "deposit", source: "email body", excerpt: "$345 deposit" }], missing_fields: [], confidence: 0.9,
    } as never;
  },
};

function setup(o: { failEmail?: (key: string, to: string) => Error | null; stripe?: StripePort; manual?: boolean } = {}) {
  let t = Date.now();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const emails: { to: string; idempotencyKey: string; bodyText: string }[] = [];
  const texts: { to: string; text: string }[] = [];
  const repo = new InMemoryRepository();
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"), ...(o.stripe ? { stripe: o.stripe } : {}),
    email: {
      async send(m) {
        const f = o.failEmail?.(m.idempotencyKey, m.to);
        if (f) throw f;
        emails.push(m);
        return { providerId: `em_${m.idempotencyKey}`, status: "sent", idempotentReplay: false, messageId: `<em_${emails.length}@haggle.test>` };
      },
    },
    sms: { async send(r) { texts.push(r); return { messageId: `sms_${texts.length}` }; } },
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 1, notifyPhone: APPROVER, ...(o.manual ? { manualPaymentHandoff: true } : {}) },
  });
  return { engine, repo, clock, emails, texts };
}
type Env = ReturnType<typeof setup>;

async function approvedDeal(env: Env) {
  const deal = await env.engine.deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: VENDOR }] });
  const b = (await env.repo.getBusinesses(deal.job_id))[0]!;
  await env.engine.ingest({ providerEventId: "ev1", eventType: "message.received", providerEmailId: "in1", threadId: "th1", messageId: "<in1@v.example>", inReplyTo: [b.rfq_message_id!], references: [b.rfq_message_id!], from: VENDOR, to: ["haggle@inkboxmail.test"], subject: "Re: Quote", bodyText: "$1,150 total, $345 deposit.", attachments: [], attachmentsDownloadUrl: null }, (e) => ({ trusted: true, address: e, reason: "trusted", evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } }));
  await env.engine.advanceJob(deal.job_id);
  const q = (await env.engine.getQuotes(deal.job_id)).quotes[0]!;
  const a = await env.engine.requestApproval(deal.job_id, q.quote_id, "imessage");
  await env.engine.ingestText({ messageId: "yes1", from: APPROVER, text: `YES ${a.code}`, inbound: true });
  return { jobId: deal.job_id, b, q, a };
}

/** Manual rail: the business confirms the booking before the customer pays it directly. */
async function bookedDeal(env: Env) {
  const r = await approvedDeal(env);
  const trusted = (e: string) => ({ trusted: true as const, address: e, reason: "trusted" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });
  const out = await env.engine.ingest({ providerEventId: "ev2", eventType: "message.received", providerEmailId: "in2", threadId: "th1", messageId: "<in2@v.example>", inReplyTo: [r.b.rfq_message_id!], references: [r.b.rfq_message_id!], from: VENDOR, to: ["haggle@inkboxmail.test"], subject: "Re: Quote", bodyText: "Confirmed, we're all set for your event.", attachments: [], attachmentsDownloadUrl: null }, trusted);
  expect(out.outcome).toBe("booking_confirmed");
  return r;
}

describe("job-ops arguments", () => {
  it("validates commands and demands who is acting", () => {
    expect(planOps(["list-stuck"])).toEqual({ kind: "list-stuck", limit: 200 });
    expect(planOps(["list-review", "--all"])).toEqual({ kind: "list-review", all: true });
    expect(planOps(["inspect", "--job", "job_abc123def"])).toEqual({ kind: "inspect", jobId: "job_abc123def" });
    expect(planOps(["retry", "--key", "rfq:job_a1b2c3:biz_d4e5f6", "--by", "yash"])).toEqual({ kind: "retry-key", key: "rfq:job_a1b2c3:biz_d4e5f6", override: false, by: "yash" });
    expect(planOps(["retry", "--payment", "pay_abc123def", "--override-financial", "--by", "yash"])).toEqual({ kind: "retry-payment", paymentId: "pay_abc123def", override: true, by: "yash" });
    expect(planOps(["resolve", "--id", "rev_abc123def", "--note", "checked the call log", "--by", "yash"])).toMatchObject({ kind: "resolve", id: "rev_abc123def" });
    expect(() => planOps(["retry", "--key", "rfq:x:y"])).toThrow(/--by/);
    expect(() => planOps(["retry", "--key", "k", "--payment", "pay_abc123", "--by", "yash"])).toThrow(/exactly one/);
    expect(() => planOps(["retry", "--key", "confirm:apr_1", "--override-financial", "--by", "yash"])).toThrow(/override-obligation/);
    expect(() => planOps(["resolve", "--id", "rev_abc123def", "--by", "yash"])).toThrow(/--note/);
    expect(() => planOps(["purge"])).toThrow(/command/);
  });
});

describe("job-ops retry planning (pure)", () => {
  const job = { id: "job_a", state: "collecting" };
  const row = (o: Partial<{ kind: "email" | "call" | "text" | "a2a"; status: "pending" | "sent" | "not_sent" | "unknown" }>) => ({ key: "k", job_id: "job_a", kind: "email" as const, status: "not_sent" as const, provider_ref: null, attempts: 3, created_at: "", updated_at: "", ...o });

  it("never redials a call that may have rung, override or not; a definitely-not-placed one is re-queued", () => {
    for (const status of ["unknown", "pending"] as const) expect(planOutboxRetry({ key: "call:job_a:biz_b", row: row({ kind: "call", status }), review: null, job, override: true, by: "ops" })).toMatchObject({ ok: false, reason: expect.stringMatching(/never redialed/) });
    expect(planOutboxRetry({ key: "call:job_a:biz_b", row: row({ kind: "call", status: "not_sent" }), review: null, job, businessStatus: "bounced", override: false, by: "ops" })).toMatchObject({ ok: true });
  });

  it("refuses obligations without the override; never x402 payment steps; never already-sent actions", () => {
    const paying = { id: "job_a", state: "paying" };
    expect(planOutboxRetry({ key: "accept:apr_1", row: row({}), review: null, job: paying, override: false, by: "ops" })).toMatchObject({ ok: false, reason: expect.stringMatching(/override-obligation/) });
    expect(planOutboxRetry({ key: "accept:apr_1", row: row({}), review: null, job: paying, override: true, by: "ops" })).toMatchObject({ ok: true });
    expect(planOutboxRetry({ key: "confirm:apr_1", row: row({}), review: null, job: paying, override: true, by: "ops" })).toMatchObject({ ok: false, reason: expect.stringMatching(/paid or confirmed/) });
    expect(planOutboxRetry({ key: "pay:step_1", row: row({}), review: null, job: paying, override: true, by: "ops" })).toMatchObject({ ok: false, reason: expect.stringMatching(/x402/) });
    expect(planOutboxRetry({ key: "rfq:job_a:biz_b", row: row({ status: "sent" }), review: null, job, override: false, by: "ops" })).toMatchObject({ ok: false, reason: expect.stringMatching(/already sent/) });
    expect(planOutboxRetry({ key: "followup:job_a:biz_b:1", row: row({}), review: null, job, override: true, by: "ops" })).toMatchObject({ ok: false });
  });

  it("a held charge is released only with --override-financial", () => {
    const review = { id: "rev_1", job_id: "job_a", kind: "payment" as const, subject: "pay_1", reason: "r", attempts: 5, last_error: null, status: "open" as const, resolution: null, resolved_by: null, resolved_at: null, created_at: "", updated_at: "" };
    expect(planChargeRelease({ payment: { id: "pay_1", job_id: "job_a", status: "charging" }, review, override: false, by: "ops" })).toMatchObject({ ok: false, reason: expect.stringMatching(/Stripe dashboard/) });
    expect(planChargeRelease({ payment: { id: "pay_1", job_id: "job_a", status: "settled" }, review, override: true, by: "ops" })).toMatchObject({ ok: false });
    expect(planChargeRelease({ payment: { id: "pay_1", job_id: "job_a", status: "charging" }, review, override: true, by: "ops" })).toMatchObject({ ok: true });
  });
});

describe("job-ops retry applied, the engine performing it", () => {
  it("an RFQ that never went out is re-queued and sent exactly once, through the normal path", async () => {
    let down = true;
    const env = setup({ failEmail: (k, to) => (down && to === VENDOR && k.startsWith("rfq:") ? new ChannelSendError("provider_error", true, 1_000, "503") : null) });
    const deal = await env.engine.deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: VENDOR }, { name: "Sunset Kitchen", email: "sunset@inkboxmail.test" }] });
    for (let i = 0; i < 4; i++) {
      env.clock.advance(60_000);
      await env.engine.advanceJob(deal.job_id);
    }
    const b = (await env.repo.getBusinesses(deal.job_id)).find((x) => x.email === VENDOR)!;
    expect(b.status).toBe("bounced");
    down = false;
    const cmd = planOps(["retry", "--key", `rfq:${deal.job_id}:${b.business_id}`, "--by", "ops"]) as Extract<ReturnType<typeof planOps>, { kind: "retry-key" }>;
    const plan = await planRetry(env.repo, cmd);
    expect(plan).toMatchObject({ ok: true });
    if (!plan.ok) return;
    await applySteps(env.repo, plan.steps, env.clock.now().toISOString());
    await env.engine.advanceJob(deal.job_id);
    await env.engine.advanceJob(deal.job_id);
    expect(env.emails.filter((e) => e.idempotencyKey.startsWith("rfq:") && e.to === VENDOR)).toHaveLength(1);
    expect((await env.repo.getBusinesses(deal.job_id)).find((x) => x.email === VENDOR)!.status).toBe("contacted");
    expect(await planRetry(env.repo, cmd)).toMatchObject({ ok: false, reason: expect.stringMatching(/already sent/) });
  });

  it("a confirmation left unknown by a crash: reviewed, listed as stuck, re-sent once only with the override", async () => {
    const env = setup({ manual: true });
    const { jobId, a } = await bookedDeal(env);
    const key = `confirm:${a.id}`;
    await env.repo.claimOutbox({ key, job_id: jobId, kind: "email" }, env.clock.now().toISOString());
    env.clock.advance(3 * 60_000);
    expect((await env.engine.ingestText({ messageId: "paid1", from: APPROVER, text: `PAID ${a.code}`, inbound: true })).outcome).toBe("handoff_confirmed");
    expect(env.emails.some((e) => e.idempotencyKey === key)).toBe(false);
    env.clock.advance(15 * 60_000);
    expect((await listStuck(env.repo, env.clock.now().getTime(), 100)).some((f) => f.subject === key && f.action === "review")).toBe(true);
    const cmd = (o: boolean) => planOps(["retry", "--key", key, ...(o ? ["--override-obligation"] : []), "--by", "ops"]) as Extract<ReturnType<typeof planOps>, { kind: "retry-key" }>;
    expect(await planRetry(env.repo, cmd(false))).toMatchObject({ ok: false, reason: expect.stringMatching(/override-obligation/) });
    const plan = await planRetry(env.repo, cmd(true));
    expect(plan).toMatchObject({ ok: true });
    if (!plan.ok) return;
    await applySteps(env.repo, plan.steps, env.clock.now().toISOString());
    await env.engine.advanceJob(jobId);
    await env.engine.advanceJob(jobId);
    expect(env.emails.filter((e) => e.idempotencyKey === key)).toHaveLength(1);
    expect((await env.repo.listReviews({ status: "open", jobId })).some((r) => r.subject === key)).toBe(false);
  });

  it.each([true, false])("a held Stripe charge, once released, re-runs the payment guard (cap lowered meanwhile: %s)", async (lowered) => {
    let charges = 0;
    const base = simulatedStripe();
    const env = setup({ stripe: { simulated: true, async charge(r) { charges++; return base.charge(r); } } });
    const { jobId, q, a } = await approvedDeal(env);
    await env.repo.touchJob(jobId, { pay_intent: true });
    await env.repo.insertPayment({ id: "pay_heldone1", job_id: jobId, approval_id: a.id, business_id: q.business_id, status: "charging", rail: "stripe", amount_cents: a.payment_cents, amount_base_units: String(a.payment_cents), network: "stripe-test", idempotency_key: `haggle-pay-${a.id}`, stripe_payment_intent_id: "pi_maybe", challenge_json: null, challenge_step_id: null, challenge_message_id: null, challenge_trusted: false, challenge_thread_matched: false, pay_to: null, interaction_json: null, settle_tx: null, simulated: true, reason: "retryable:stripe_unreachable" } as never);
    // Five retryable failures already (network): the next advance holds it for an operator.
    for (let i = 0; i < 5; i++) await env.repo.appendEvent(jobId, "payment_retry", { payment_id: "pay_heldone1", reason: "stripe_unreachable" });
    env.clock.advance(2 * 60_000);
    await env.engine.advanceJob(jobId);
    expect(charges).toBe(0);
    if (lowered) await env.engine.updateSettings({ spending_cap_cents: 10_000 });
    const cmd = planOps(["retry", "--payment", "pay_heldone1", "--override-financial", "--by", "ops"]) as Extract<ReturnType<typeof planOps>, { kind: "retry-payment" }>;
    const plan = await planRetry(env.repo, cmd);
    expect(plan).toMatchObject({ ok: true });
    if (!plan.ok) return;
    await applySteps(env.repo, plan.steps, env.clock.now().toISOString());
    await env.engine.advanceJob(jobId);
    await env.engine.advanceJob(jobId);
    expect(charges).toBe(lowered ? 0 : 1);
    expect((await env.repo.getPaymentForJob(jobId))!).toMatchObject(lowered ? { status: "failed", reason: expect.stringMatching(/^refused:/) } : { status: "settled" });
  });
});
