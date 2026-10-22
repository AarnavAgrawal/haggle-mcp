// Background reliability (overnight sprint, workstream C): job leases that fence a stale holder,
// every external side effect claimed in the outbox, crash injection between claim / send / record,
// dead letters (operator review) instead of silent endless retries, stuck-job recovery, and vendor
// replies that arrive hours or days late. Real engine, fake ports, a fake clock; no network.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, type EngineConfig, type ExtractorPort } from "../src/index.ts";
import { simulatedStripe, type StripePort } from "../src/payments/stripe.ts";
import { PostgresRepository } from "../src/store/postgres.ts";
import { ChannelSendError, type A2APort, type PhonePort } from "../src/workflow/ports.ts";
import type { TrustVerdict } from "../src/inbound/primitive.ts";
import type { Repository } from "../src/store/types.ts";
import { decideChargeResume, decideClaim, isObligationKey, redactError } from "../src/workflow/deadLetter.ts";
import { planRecovery } from "../src/workflow/recovery.ts";

const APPROVER = "+14155550101";
const { budget_usd, ...request } = GOLDEN_REQUEST;
const noEvidence = { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] };
const trusted = (expected: string): TrustVerdict => ({ trusted: true, address: expected, reason: "trusted", evidence: noEvidence });

const textExtractor: ExtractorPort = {
  async extract(i) {
    const t = i.bodyText.split("[The business's reply]:")[1] ?? i.bodyText;
    const money = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
    const total = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*total/i);
    const deposit = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*deposit/i);
    return {
      available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true,
      tax_usd: null, tax_included: true, total_usd: total, deposit_usd: deposit, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }],
      valid_until: null, questions: [], payment_request: "none", instructions_to_agent: false,
      sources: [...(total !== null ? [{ field: "total" as const, source: "email body", excerpt: `$${total} total` }] : []), ...(deposit !== null ? [{ field: "deposit" as const, source: "email body", excerpt: `$${deposit} deposit` }] : [])],
      missing_fields: total === null ? ["total"] : [], confidence: 0.9,
    } as never;
  },
};

type Clock = { now: () => Date; advance: (ms: number) => void };
const newClock = (): Clock => {
  let t = Date.now();
  return { now: () => new Date(t), advance: (ms) => { t += ms; } };
};

type Opts = { repo?: Repository; stripe?: StripePort; extractor?: ExtractorPort; clock?: Clock; phone?: PhonePort; a2a?: A2APort; imessage?: boolean; emailFails?: () => Error | null };

function setup(config: Partial<EngineConfig> = {}, opts: Opts = {}) {
  const clock = opts.clock ?? newClock();
  const emails: { to: string; subject: string; bodyText: string; idempotencyKey: string }[] = [];
  const texts: { to: string; text: string; idempotencyKey: string }[] = [];
  const imsgs: { to: string; text: string; idempotencyKey: string }[] = [];
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const repo = (opts.repo ?? new InMemoryRepository()) as InMemoryRepository;
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor: opts.extractor ?? textExtractor, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    ...(opts.stripe ? { stripe: opts.stripe } : {}), ...(opts.phone ? { phone: opts.phone } : {}), ...(opts.a2a ? { a2a: opts.a2a } : {}),
    ...(opts.imessage ? { imessage: { async send(r) { imsgs.push(r); return { messageId: `im_${imsgs.length}` }; } } } : {}),
    email: {
      async send(m) {
        const fail = opts.emailFails?.();
        if (fail) throw fail;
        emails.push(m);
        return { providerId: `em_${m.idempotencyKey}`, status: "sent", idempotentReplay: false, messageId: `<em_${emails.length}_${m.idempotencyKey.replace(/\W/g, "")}@haggle.test>` };
      },
    },
    sms: { async send(r) { texts.push(r); return { messageId: `sms_${texts.length}` }; } },
    log: (event, data) => logs.push({ event, data }),
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 500_000, maxRounds: 1, notifyPhone: APPROVER, ...config,
    },
  });
  return { engine, repo, clock, emails, texts, imsgs, logs };
}
type Env = ReturnType<typeof setup>;

const VENDOR = "harbor@inkboxmail.test";
async function dealWith(env: Env, businesses: { name: string; email?: string; phone?: string; a2a_card_url?: string }[] = [{ name: "Harbor Table", email: VENDOR }]) {
  const deal = await env.engine.deal({ request, budget_usd, businesses });
  return { jobId: deal.job_id, bs: await env.repo.getBusinesses(deal.job_id) };
}

let mailN = 0;
function mail(env: Env, b: { rfq_message_id: string | null; email: string | null }, bodyText: string) {
  const n = ++mailN;
  const rfq = b.rfq_message_id!;
  return env.engine.ingest({ providerEventId: `ev_r${n}`, eventType: "message.received", providerEmailId: `in_r${n}_${Math.random().toString(36).slice(2, 8)}`, threadId: `th_r${n}`, messageId: `<in_r${n}@vendor.example>`, inReplyTo: [rfq], references: [rfq], from: b.email!, to: ["haggle@inkboxmail.test"], subject: "Re: Quote request", bodyText, attachments: [], attachmentsDownloadUrl: null }, trusted);
}

/** Through approval by the human's YES text; returns the approved quote and approval. */
async function approved(env: Env, body = "We can do it: $1,150 total, delivered. $345 deposit.") {
  const { jobId, bs } = await dealWith(env);
  await mail(env, bs[0]!, body);
  await env.engine.advanceJob(jobId);
  const q = (await env.engine.getQuotes(jobId)).quotes[0]!;
  const a = await env.engine.requestApproval(jobId, q.quote_id, "imessage");
  expect(await env.engine.ingestText({ messageId: `yes_${a.id}`, from: APPROVER, text: `YES ${a.code}`, inbound: true })).toMatchObject({ outcome: "approved" });
  return { jobId, b: bs[0]!, q, a };
}

/**
 * Crash injection: the process dies right after Inkbox accepted a call, before the call's message
 * row is written. The write never completes (a dead process doesn't run its error handlers).
 */
function crashOnFirstCallRecord(repo: Repository) {
  const insert = repo.insertMessage.bind(repo);
  let crashedNow!: () => void;
  const crashed = new Promise<void>((r) => { crashedNow = r; });
  let done = false;
  repo.insertMessage = async (m) => {
    if (!done && m.kind === "call" && m.direction === "out") {
      done = true;
      crashedNow();
      return new Promise<never>(() => {});
    }
    return insert(m);
  };
  return { crashed };
}

const reviews = (repo: Repository, jobId?: string) => repo.listReviews({ status: "open", ...(jobId ? { jobId } : {}) });

// ───────────────────────────── leases ─────────────────────────────

describe("job leases: renewal and fencing", () => {
  it("an advance that outlives its lease is fenced: once another instance holds the job, the stale holder sends nothing", async () => {
    const repo = new InMemoryRepository();
    const clock = newClock();
    let entered!: () => void;
    const inRead = new Promise<void>((r) => { entered = r; });
    let resume!: () => void;
    const gate = new Promise<void>((r) => { resume = r; });
    const slow: ExtractorPort = { async extract(i) { entered(); await gate; return textExtractor.extract(i); } };
    const a = setup({ instanceId: "a", leaseTtlMs: 60_000 }, { repo, clock, extractor: slow });
    const { jobId, bs } = await dealWith(a);
    // No total stated: reading it makes Haggle ask for the exact total (a send after the slow read).
    await mail(a, bs[0]!, "We can do it for 40 guests, delivered. Price per head 28, deposit 30%.");
    const sentBefore = a.emails.length;
    const run = a.engine.advanceJob(jobId);
    await inRead;
    // The read outlives the lease (no renewal tick in fake time); another instance takes the job.
    clock.advance(61_000);
    expect(await repo.acquireJobLease(jobId, "b#1", clock.now().toISOString(), 60_000)).toBe(true);
    resume();
    await run;
    expect(a.emails.length).toBe(sentBefore); // the stale holder's follow-up never went out
    expect(a.logs.some((l) => l.event === "lease_lost")).toBe(true);
    expect((await repo.getBusinesses(jobId))[0]!.status).not.toBe("bounced");
    // The new holder is unaffected: its own release is untouched by the stale holder's release.
    expect(await repo.acquireJobLease(jobId, "c#1", clock.now().toISOString(), 60_000)).toBe(false);
  });

  it("a long advance renews its lease while it runs, so another instance can't take the job from a live holder", async () => {
    const repo = new InMemoryRepository();
    let resume!: () => void;
    const gate = new Promise<void>((r) => { resume = r; });
    let entered!: () => void;
    const inRead = new Promise<void>((r) => { entered = r; });
    const slow: ExtractorPort = { async extract(i) { entered(); await gate; return textExtractor.extract(i); } };
    // Real time here: the lease is 90 ms, renewed every 30 ms by the running advance.
    const real = { now: () => new Date(), advance: () => {} };
    const a = setup({ instanceId: "a", leaseTtlMs: 90 }, { repo, clock: real, extractor: slow });
    const b = setup({ instanceId: "b", leaseTtlMs: 90 }, { repo, clock: real });
    const { jobId, bs } = await dealWith(a);
    await mail(a, bs[0]!, "We can do it: $1,150 total, delivered. $345 deposit.");
    const run = a.engine.advanceJob(jobId);
    await inRead;
    await new Promise((r) => setTimeout(r, 300)); // over three TTLs
    await b.engine.advanceJob(jobId);
    expect(b.logs.some((l) => l.event === "advance_skipped_leased")).toBe(true);
    resume();
    await run;
    expect((await repo.listEvents(jobId)).filter((e) => e.type === "quote")).toHaveLength(1);
  });

  it("a crashed holder's lease expires and another instance re-acquires and advances the job", async () => {
    const repo = new InMemoryRepository();
    const clock = newClock();
    const b = setup({ instanceId: "b" }, { repo, clock });
    const { jobId, bs } = await dealWith(b);
    expect(await repo.acquireJobLease(jobId, "crashed#1", clock.now().toISOString(), 5 * 60_000)).toBe(true);
    await mail(b, bs[0]!, "We can do it: $1,150 total, delivered. $345 deposit.");
    await b.engine.advanceJob(jobId);
    expect((await b.engine.getQuotes(jobId)).quotes).toHaveLength(0);
    clock.advance(5 * 60_000 + 1);
    await b.engine.advanceJob(jobId);
    expect((await b.engine.getQuotes(jobId)).quotes).toHaveLength(1);
  });
});

// ───────────────────────────── outbox ─────────────────────────────

const a2aFleet = () => {
  const sent: { messageId: string; text: string }[] = [];
  const port: A2APort = {
    async send(r) { sent.push({ messageId: r.messageId, text: r.text }); return { taskId: `task_${sent.length}`, contextId: r.contextId ?? `ctx_${sent.length}`, state: "submitted" }; },
    async getTask() { return { state: "working", agentMessages: [] } as never; },
  };
  return { port, sent };
};

describe("outbox: every external side effect is claimed and keyed", () => {
  it("an A2A task claimed by another instance moments ago is not sent again (A2A had no claim)", async () => {
    const fleet = a2aFleet();
    const env = setup({}, { a2a: fleet.port });
    const { jobId, bs } = await dealWith(env, [{ name: "Bay Agent", a2a_card_url: "https://agent.example/.well-known/agent-card.json" }]);
    expect(fleet.sent).toHaveLength(1);
    expect((await env.repo.getOutbox(`a2a:${jobId}:${bs[0]!.business_id}`))!.status).toBe("sent");
    const b = (await env.repo.getBusinesses(jobId))[0]!;
    const key = `msg:a2a-test:${jobId}`;
    await env.repo.claimOutbox({ key, job_id: jobId, kind: "a2a" }, env.clock.now().toISOString());
    const job = (await env.repo.getJob(jobId))!;
    const sendA2aMessage = (env.engine as unknown as { sendA2aMessage: (j: unknown, b: unknown, k: string, key: string, t: string) => Promise<unknown> }).sendA2aMessage.bind(env.engine);
    await expect(sendA2aMessage(job, b, "message", key, "hello")).rejects.toMatchObject({ name: "ChannelSendError", retryable: true });
    expect(fleet.sent).toHaveLength(1);
  });

  it("the approval iMessage to the human is claimed: a claim in flight elsewhere is never sent twice", async () => {
    const env = setup({}, { imessage: true });
    await env.engine.updateSettings({ approver_phone: APPROVER } as never).catch(() => undefined);
    const { jobId, bs } = await dealWith(env);
    await mail(env, bs[0]!, "We can do it: $1,150 total, delivered. $345 deposit.");
    await env.engine.advanceJob(jobId);
    const q = (await env.engine.getQuotes(jobId)).quotes[0]!;
    const before = env.imsgs.length;
    // Another instance is sending every approval iMessage right now.
    const claimAll = env.repo.claimOutbox.bind(env.repo);
    (env.repo as unknown as { claimOutbox: typeof claimAll }).claimOutbox = async (o, now) => (o.key.startsWith("imsg:approval:") ? { fresh: false, row: { ...o, status: "pending", provider_ref: null, attempts: 1, created_at: now, updated_at: now } } : claimAll(o, now));
    await env.engine.requestApproval(jobId, q.quote_id, "imessage").catch(() => undefined);
    expect(env.imsgs.length).toBe(before);
  });

  it("texts to the human fail closed when the outbox can't record the claim", async () => {
    const env = setup();
    const { jobId } = await dealWith(env);
    (env.repo as unknown as { claimOutbox: () => Promise<never> }).claimOutbox = async () => { throw new Error("connection terminated"); };
    const before = env.texts.length;
    const job = (await env.repo.getJob(jobId))!;
    const textHuman = (env.engine as unknown as { textHuman: (j: unknown, to: string, t: unknown) => Promise<{ ok: boolean; reason?: string }> }).textHuman.bind(env.engine);
    expect(await textHuman(job, APPROVER, { key: `notify:${jobId}:x`, text: "Haggle: hi" })).toMatchObject({ ok: false, reason: "outbox_unavailable" });
    expect(env.texts.length).toBe(before);
  });

  it("crash between dialing and recording the call: the call.ended transcript is still read, and the call is never redialed", async () => {
    const calls: string[] = [];
    const phone: PhonePort = { async placeCall(r) { calls.push(r.idempotencyKey); return { callId: `call_${calls.length}` }; } };
    const repo = new InMemoryRepository();
    const crash = crashOnFirstCallRecord(repo);
    const dead = setup({ instanceId: "dead" }, { repo, phone });
    void dealWith(dead, [{ name: "Mission Eats", phone: "+14155550104" }]);
    await crash.crashed;
    const jobId = (await repo.listOpenJobs())[0]!.id;
    expect(calls).toHaveLength(1);
    // The restarted process (same database, later).
    const env = setup({ instanceId: "restarted" }, { repo, phone, clock: dead.clock });
    for (let i = 0; i < 3; i++) {
      env.clock.advance(5 * 60_000);
      await env.engine.advanceJob(jobId);
    }
    expect(calls).toHaveLength(1); // never redialed
    const r = await env.engine.ingestCall({ callId: "call_1", outcome: "completed", transcript: "Haggle (AI assistant): Hi, calling about a catering quote.\nMission Eats: Sure, we can do it for $1,150 total delivered, with a $345 deposit.", remoteNumber: "+14155550104" });
    expect(r.outcome).toBe("stored");
    expect((await repo.listEvents(jobId)).some((e) => e.type === "recovered" && e.data.from === "call_record_lost")).toBe(true);
  });

  it("a call whose outcome is unknown goes to operator review at once and is never redialed", async () => {
    let n = 0;
    const phone: PhonePort = { async placeCall() { n++; throw new ChannelSendError("provider_error", true, 1_000, "HTTP 502 after send", true); } };
    const env = setup({}, { phone });
    const { jobId } = await dealWith(env, [{ name: "Mission Eats", phone: "+14155550104" }]);
    for (let i = 0; i < 4; i++) {
      env.clock.advance(5 * 60_000);
      await env.engine.advanceJob(jobId);
    }
    expect(n).toBe(1);
    const open = await reviews(env.repo, jobId);
    expect(open.find((r) => r.kind === "outbox" && r.subject.startsWith("call:"))).toMatchObject({ reason: expect.stringMatching(/never redialed/) });
  });

  it("crash between claim and send of an obligation (a confirmation): it is never re-sent automatically; an operator reviews it", async () => {
    const env = setup({ manualPaymentHandoff: true });
    const { jobId, a } = await approved(env);
    const key = `confirm:${a.id}`;
    await env.repo.claimOutbox({ key, job_id: jobId, kind: "email" }, env.clock.now().toISOString());
    env.clock.advance(3 * 60_000);
    const before = env.emails.length;
    expect((await env.engine.ingestText({ messageId: "paid1", from: APPROVER, text: `PAID ${a.code}`, inbound: true })).outcome).toBe("handoff_confirmed");
    expect(env.emails.slice(before).some((e) => e.idempotencyKey === key)).toBe(false);
    expect((await reviews(env.repo, jobId)).some((r) => r.kind === "outbox" && r.subject === key)).toBe(true);
  });

  it("crash between claim and send of an RFQ: resent once under the same provider key", async () => {
    const env = setup();
    const { jobId, bs } = await dealWith(env);
    const key = `test-rfq:${jobId}`;
    await env.repo.claimOutbox({ key, job_id: jobId, kind: "email" }, env.clock.now().toISOString());
    env.clock.advance(3 * 60_000);
    const job = (await env.repo.getJob(jobId))!;
    const sendRecorded = (env.engine as unknown as { sendRecorded: (j: unknown, b: unknown, k: string, key: string, m: unknown) => Promise<unknown> }).sendRecorded.bind(env.engine);
    await sendRecorded(job, bs[0], "followup", key, { to: VENDOR, subject: "x", bodyText: "y" });
    await sendRecorded(job, bs[0], "followup", key, { to: VENDOR, subject: "x", bodyText: "y" });
    expect(env.emails.filter((e) => e.idempotencyKey === key)).toHaveLength(1);
  });

  it("an action that keeps failing goes to operator review after a bounded number of attempts, with a redacted error, and is never retried silently", async () => {
    let fail = true;
    const env = setup({}, { emailFails: () => (fail ? new Error("SMTP 451 for orders@harbor.example via sk_test_abcdef123 at +1 415 555 0199") : null) });
    const { jobId } = await dealWith(env).catch(async () => ({ jobId: "" }));
    fail = true;
    const job = (await env.repo.listOpenJobs())[0] ?? (await env.repo.getJob(jobId))!;
    const b = (await env.repo.getBusinesses(job.id))[0]!;
    const key = `followup:${job.id}:${b.business_id}:9`;
    const sendRecorded = (env.engine as unknown as { sendRecorded: (j: unknown, b: unknown, k: string, key: string, m: unknown) => Promise<unknown> }).sendRecorded.bind(env.engine);
    for (let i = 0; i < 8; i++) await sendRecorded(job, b, "followup", key, { to: VENDOR, subject: "x", bodyText: "y" }).catch(() => undefined);
    const row = (await env.repo.getOutbox(key))!;
    expect(row.attempts).toBe(5);
    const rev = (await reviews(env.repo)).find((r) => r.subject === key)!;
    expect(rev).toMatchObject({ kind: "outbox", attempts: 5 });
    expect(rev.last_error).not.toMatch(/harbor\.example|sk_test|555/);
    // Even once the provider recovers, it stays put until an operator resolves the review.
    fail = false;
    await sendRecorded(job, b, "followup", key, { to: VENDOR, subject: "x", bodyText: "y" }).catch(() => undefined);
    expect(env.emails.filter((e) => e.idempotencyKey === key)).toHaveLength(0);
  });
});

// ───────────────────────────── payments ─────────────────────────────

describe("a stale or failing Stripe charge is held for an operator, never resumed blindly", () => {
  async function charging(stripe: StripePort) {
    const env = setup({}, { stripe });
    const { jobId, q, a } = await approved(env);
    await env.repo.touchJob(jobId, { pay_intent: true });
    await env.repo.insertPayment({ id: `pay_${a.id}`, job_id: jobId, approval_id: a.id, business_id: q.business_id, status: "charging", rail: "stripe", amount_cents: a.payment_cents, amount_base_units: String(a.payment_cents), network: "stripe-test", idempotency_key: `haggle-pay-${a.id}`, stripe_payment_intent_id: null, challenge_json: null, challenge_step_id: null, challenge_message_id: null, challenge_trusted: false, challenge_thread_matched: false, pay_to: null, interaction_json: null, settle_tx: null, simulated: true, reason: null } as never);
    return { env, jobId, a };
  }

  it("a `charging` row older than Stripe's idempotency window is not charged again; it goes to review", async () => {
    let charges = 0;
    const base = simulatedStripe();
    const { env, jobId, a } = await charging({ simulated: true, async charge(r) { charges++; return base.charge(r); } });
    env.clock.advance(21 * 60 * 60_000);
    await env.engine.advanceJob(jobId);
    expect(charges).toBe(0);
    expect((await reviews(env.repo, jobId)).find((r) => r.kind === "payment" && r.subject === `pay_${a.id}`)).toBeTruthy();
    expect((await env.repo.getPaymentForJob(jobId))!.status).toBe("charging");
  });

  it("retryable charge failures stop after a bounded number of resumes", async () => {
    let charges = 0;
    const { env, jobId } = await charging({ simulated: true, async charge() { charges++; return { ok: false, reason: "stripe_unreachable", retryable: true }; } });
    for (let i = 0; i < 10; i++) {
      env.clock.advance(2 * 60_000);
      await env.engine.advanceJob(jobId);
    }
    expect(charges).toBe(5);
    expect((await reviews(env.repo, jobId)).some((r) => r.kind === "payment")).toBe(true);
  });
});

// ───────────────────────────── stuck jobs ─────────────────────────────

describe("stuck-job recovery (the backup tick)", () => {
  it("a job past its deadline is advanced; one still stuck long after goes to operator review once", async () => {
    const env = setup();
    const { jobId } = await dealWith(env);
    // A held lease that never expires (a wedged instance): nothing can advance the job.
    await env.repo.acquireJobLease(jobId, "wedged#1", env.clock.now().toISOString(), 365 * 86_400_000);
    env.clock.advance(31 * 60_000 + 5 * 60_000);
    await env.engine.advanceAllOpen();
    env.clock.advance(31 * 60_000);
    await env.engine.advanceAllOpen();
    await env.engine.advanceAllOpen();
    const open = (await reviews(env.repo, jobId)).filter((r) => r.kind === "stuck_job");
    expect(open).toHaveLength(1);
    expect(open[0]!.subject).toBe(`${jobId}:collection_overdue`);
  });

  it("collecting past collect_until closes on the next tick (no reply waits forever)", async () => {
    const env = setup();
    const { jobId } = await dealWith(env);
    env.clock.advance(31 * 60_000);
    await env.engine.advanceAllOpen();
    expect((await env.repo.getJob(jobId))!.ready || (await env.repo.getJob(jobId))!.state !== "collecting").toBe(true);
    expect(await reviews(env.repo, jobId)).toHaveLength(0);
  });

  it("an expired approval is cleared by the tick", async () => {
    const env = setup();
    const { jobId, bs } = await dealWith(env);
    await mail(env, bs[0]!, "We can do it: $1,150 total, delivered. $345 deposit.");
    await env.engine.advanceJob(jobId);
    const q = (await env.engine.getQuotes(jobId)).quotes[0]!;
    const a = await env.engine.requestApproval(jobId, q.quote_id, "imessage");
    env.clock.advance(31 * 60_000);
    await env.engine.advanceAllOpen();
    expect((await env.repo.getApproval(a.id))!.status).toBe("expired");
    expect((await env.repo.getJob(jobId))!.state).not.toBe("awaiting_approval");
  });

  it("a call claim left pending by a crash is recorded as unknown and reviewed, never redialed", async () => {
    const calls: string[] = [];
    const phone: PhonePort = { async placeCall(r) { calls.push(r.idempotencyKey); return { callId: `c_${calls.length}` }; } };
    const env = setup({}, { phone });
    const { jobId } = await dealWith(env);
    await env.repo.claimOutbox({ key: `call:${jobId}:biz_crashcall`, job_id: jobId, kind: "call" }, env.clock.now().toISOString());
    env.clock.advance(3 * 60_000);
    await env.engine.advanceAllOpen();
    expect((await env.repo.getOutbox(`call:${jobId}:biz_crashcall`))!.status).toBe("unknown");
    expect((await reviews(env.repo, jobId)).some((r) => r.subject === `call:${jobId}:biz_crashcall`)).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

// ───────────────────────────── late replies ─────────────────────────────

describe("vendor replies hours or days late", () => {
  it("a reply after collect_until but before the window was processed still counts as a quote", async () => {
    const env = setup();
    const { jobId, bs } = await dealWith(env);
    env.clock.advance(3 * 60 * 60_000);
    await mail(env, bs[0]!, "Sorry for the delay: $1,150 total, delivered. $345 deposit.");
    await env.engine.advanceJob(jobId);
    expect((await env.engine.getQuotes(jobId)).quotes.map((q) => q.total_usd)).toEqual([1150]);
  });

  it("a reply from another business after a quote was approved is stored and shown, and the approved deal is unchanged", async () => {
    const env = setup({ manualPaymentHandoff: true });
    const { jobId, bs } = await dealWith(env, [{ name: "Harbor Table", email: VENDOR }, { name: "Sunset Kitchen", email: "sunset@inkboxmail.test" }]);
    await mail(env, bs.find((b) => b.email === VENDOR)!, "We can do it: $1,150 total, delivered. $345 deposit.");
    await env.engine.advanceJob(jobId);
    const q = (await env.engine.getQuotes(jobId)).quotes[0]!;
    const a = await env.engine.requestApproval(jobId, q.quote_id, "imessage");
    await env.engine.ingestText({ messageId: "yes_late", from: APPROVER, text: `YES ${a.code}`, inbound: true });
    env.clock.advance(6 * 60 * 60_000);
    const sunset = bs.find((b) => b.email === "sunset@inkboxmail.test")!;
    expect((await mail(env, sunset, "Late, but: $700 total, delivered. $100 deposit.")).outcome).toBe("stored");
    await env.engine.advanceJob(jobId);
    const after = (await env.repo.getApproval(a.id))!;
    expect(after).toMatchObject({ quote_id: q.quote_id, payment_cents: a.payment_cents, quote_total_cents: a.quote_total_cents });
    expect(["approved", "used"]).toContain(after.status);
    expect((await env.repo.listMessages(jobId)).filter((m) => m.direction === "in" && m.business_id === sunset.business_id)).toHaveLength(1);
    expect((await env.repo.listEvents(jobId)).some((e) => e.type === "reply" && e.data.business_id === sunset.business_id)).toBe(true);
  });

  it("a revised price from the approved business never silently changes what was approved", async () => {
    const env = setup({}, { stripe: simulatedStripe() });
    const { jobId, b, q, a } = await approved(env);
    env.clock.advance(4 * 60 * 60_000);
    await mail(env, b, "Update: it's now $1,900 total. $500 deposit.");
    await env.engine.advanceJob(jobId);
    const after = (await env.repo.getApproval(a.id))!;
    expect(after).toMatchObject({ quote_id: q.quote_id, payment_cents: a.payment_cents, quote_total_cents: a.quote_total_cents });
    // Either it still stands for the old terms or it was visibly voided; never moved to the new price.
    if (after.status !== "approved") expect((await env.repo.listEvents(jobId)).some((e) => /approval_void|approval_superseded|quote_revised|reply/.test(e.type))).toBe(true);
    await env.engine.pay(jobId, q.quote_id).catch(() => undefined);
    const p = await env.repo.getPaymentForJob(jobId);
    if (p) expect(p.amount_cents).toBe(a.payment_cents);
  });

  it("a reply days after the deal closed is stored, shown on the board, texted to the human, and never read into the deal", async () => {
    const env = setup({ manualPaymentHandoff: true });
    const { jobId, b, a } = await approved(env);
    expect((await env.engine.ingestText({ messageId: "paid_late", from: APPROVER, text: `PAID ${a.code}`, inbound: true })).outcome).toBe("handoff_confirmed");
    expect((await env.repo.getJob(jobId))!.state).toBe("paid");
    const quotesBefore = (await env.repo.listQuotes(jobId)).length;
    env.clock.advance(3 * 86_400_000);
    expect((await mail(env, b, "Actually we can't do that date. New price $2,400 total.")).outcome).toMatch(/stored|job_closed/);
    await env.engine.advanceJob(jobId);
    const msgs = (await env.repo.listMessages(jobId)).filter((m) => m.direction === "in" && /can't do that date/.test(m.body_text ?? ""));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.parse_status).not.toBe("pending");
    expect((await env.repo.listQuotes(jobId)).length).toBe(quotesBefore);
    expect((await env.repo.getJob(jobId))!.state).toBe("paid");
    expect((await env.repo.listEvents(jobId)).some((e) => e.type === "late_reply")).toBe(true);
    expect((await env.repo.listEvents(jobId)).some((e) => e.type === "reply" && e.data.kind === "late_reply" && /after this deal was paid/.test(String(e.data.summary)))).toBe(true);
    expect(env.texts.at(-1)!.text).toMatch(/replied after this deal closed/);
  });
});

// ───────────────────────────── dead letters ─────────────────────────────

describe("operator review (dead letters)", () => {
  it("a reply that can't be read goes to review once, with a redacted error", async () => {
    const broken: ExtractorPort = { async extract() { throw Object.assign(new Error("schema mismatch for orders@harbor.example"), { name: "SchemaError" }); } };
    const env = setup({}, { extractor: broken });
    const { jobId, bs } = await dealWith(env);
    await mail(env, bs[0]!, "We can do it: $1,150 total.");
    await env.engine.advanceJob(jobId);
    await env.engine.advanceJob(jobId);
    const r = (await reviews(env.repo, jobId)).filter((x) => x.kind === "parse");
    expect(r).toHaveLength(1);
    expect(r[0]!.last_error).not.toMatch(/harbor\.example/);
  });

  it("the reconciler's give-ups are reviewable", async () => {
    const env = setup();
    await env.engine.reportReconcileGaveUp({ key: "mail:msg_123", attempts: 5, error: new Error("503 from inkbox for +14155550123") });
    const [r] = await reviews(env.repo);
    expect(r).toMatchObject({ kind: "reconcile", subject: "mail:msg_123", attempts: 5 });
    expect(r!.last_error).not.toMatch(/4155550123/);
  });
});

// ───────────────────────────── Postgres (two instances) ─────────────────────────────

const PG_URL = process.env.HAGGLE_TEST_DATABASE_URL;
describe.skipIf(!PG_URL)("reliability on Postgres (two instances, migration 109)", { timeout: 60_000 }, () => {
  const uniq = () => Math.random().toString(36).slice(2, 8);

  it("fencing: a stale holder can't renew a lease another process took; two processes never both hold it", async () => {
    const [p1, p2] = [new PostgresRepository(PG_URL!), new PostgresRepository(PG_URL!)];
    try {
      const env = setup({ instanceId: "pg_a" }, { repo: p1 });
      const { jobId } = await dealWith(env, [{ name: "Harbor", email: `harbor-${uniq()}@inkboxmail.test` }]);
      const t0 = new Date();
      expect(await p1.acquireJobLease(jobId, "a#1", t0.toISOString(), 1_000)).toBe(true);
      expect(await p2.acquireJobLease(jobId, "b#1", t0.toISOString(), 1_000)).toBe(false);
      expect(await p1.renewJobLease(jobId, "a#1", t0.toISOString(), 1_000)).toBe(true);
      const later = new Date(t0.getTime() + 2_000).toISOString();
      const both = await Promise.all([p1.acquireJobLease(jobId, "c#1", later, 1_000), p2.acquireJobLease(jobId, "d#1", later, 1_000)]);
      expect(both.filter(Boolean)).toHaveLength(1);
      expect(await p1.renewJobLease(jobId, "a#1", later, 1_000)).toBe(false);
    } finally {
      await Promise.all([p1.close(), p2.close()]);
    }
  });

  it("the stale-holder fence end to end: process A's follow-up is refused once process B holds the job", async () => {
    const [p1, p2] = [new PostgresRepository(PG_URL!), new PostgresRepository(PG_URL!)];
    try {
      const clock = newClock();
      let entered!: () => void;
      const inRead = new Promise<void>((r) => { entered = r; });
      let resume!: () => void;
      const gate = new Promise<void>((r) => { resume = r; });
      const slow: ExtractorPort = { async extract(i) { entered(); await gate; return textExtractor.extract(i); } };
      const a = setup({ instanceId: "pg_fence_a", leaseTtlMs: 60_000 }, { repo: p1, clock, extractor: slow });
      const addr = `harbor-${uniq()}@inkboxmail.test`;
      const { jobId, bs } = await dealWith(a, [{ name: "Harbor", email: addr }]);
      await mail(a, bs[0]!, "We can do it for 40 guests, delivered. Price per head 28, deposit 30%.");
      const before = a.emails.length;
      const run = a.engine.advanceJob(jobId);
      await inRead;
      clock.advance(61_000);
      expect(await p2.acquireJobLease(jobId, "pg_fence_b#1", clock.now().toISOString(), 60_000)).toBe(true);
      resume();
      await run;
      expect(a.emails.length).toBe(before);
    } finally {
      await Promise.all([p1.close(), p2.close()]);
    }
  });

  it("dead letters: one open review per subject; a reviewed outbox action can't be claimed again; an unknown call can't become not_sent", async () => {
    const pg = new PostgresRepository(PG_URL!);
    try {
      const now = new Date().toISOString();
      const key = `email:${uniq()}`;
      await pg.claimOutbox({ key, job_id: null, kind: "email" }, now);
      await pg.finishOutbox(key, "not_sent", null, now);
      const r1 = await pg.openReview({ id: `rev_${uniq()}`, job_id: null, kind: "outbox", subject: key, reason: "x", attempts: 5, last_error: "e1" }, now);
      const r2 = await pg.openReview({ id: `rev_${uniq()}`, job_id: null, kind: "outbox", subject: key, reason: "y", attempts: 6, last_error: null }, now);
      expect(r1.created).toBe(true);
      expect(r2).toMatchObject({ created: false, row: { id: r1.row.id, attempts: 6, last_error: "e1", reason: "y" } });
      await expect(pg.reclaimOutbox(key, ["not_sent"], now)).rejects.toThrow(/operator review/);
      expect(await pg.resolveReview(r1.row.id, { resolution: "retry", resolved_by: "ops" }, now)).toMatchObject({ status: "resolved" });
      expect(await pg.resolveReview(r1.row.id, { resolution: "again", resolved_by: "ops" }, now)).toBeNull();
      expect(await pg.reclaimOutbox(key, ["not_sent"], now)).toMatchObject({ status: "pending", attempts: 2 });
      const call = `call:${uniq()}`;
      await pg.claimOutbox({ key: call, job_id: null, kind: "call" }, now);
      await pg.finishOutbox(call, "unknown", null, now);
      await expect(pg.finishOutbox(call, "not_sent", null, now)).rejects.toThrow(/never marked not sent/);
      expect(await pg.rearmOutbox(call, now)).toBeNull();
      expect(await pg.findOutboxByProviderRef("nope")).toBeNull();
      expect((await pg.listReviews({ status: "open" })).some((r) => r.subject === key)).toBe(false);
    } finally {
      await pg.close();
    }
  });

  it("crash between dialing and recording on Postgres: the transcript is recovered from the outbox", async () => {
    const pg = new PostgresRepository(PG_URL!);
    try {
      const calls: string[] = [];
      const phone: PhonePort = { async placeCall(r) { calls.push(r.idempotencyKey); return { callId: `pgcall_${uniq()}` }; } };
      const dead = new PostgresRepository(PG_URL!);
      const crash = crashOnFirstCallRecord(dead);
      const num = `+1415555${String(Math.floor(Math.random() * 9000) + 1000)}`;
      void dealWith(setup({ instanceId: "pg_dead" }, { repo: dead, phone }), [{ name: "Phone Co", phone: num }]);
      await crash.crashed;
      const env = setup({ instanceId: "pg_restarted" }, { repo: pg, phone });
      const jobId = (await pg.listOutbox({ statuses: ["sent"], limit: 5000 })).find((x) => x.kind === "call" && calls.includes(x.key))!.job_id!;
      const o = (await pg.listOutbox({ jobId }))[0]!;
      expect(o).toMatchObject({ kind: "call", status: "sent" });
      const r = await env.engine.ingestCall({ callId: o.provider_ref!, outcome: "completed", transcript: "Haggle (AI assistant): Hi, calling about a catering quote.\nPhone Co: Sure, we can do it for $1,150 total delivered, with a $345 deposit.", remoteNumber: num });
      expect(r.outcome).toBe("stored");
      expect(calls).toHaveLength(1);
    } finally {
      await pg.close();
    }
  });
});

// ───────────────────────────── policy (pure) ─────────────────────────────

describe("reliability policy (pure)", () => {
  const T = Date.parse("2026-10-22T12:00:00Z");
  const ago = (ms: number) => new Date(T - ms).toISOString();
  const row = (status: "pending" | "sent" | "not_sent" | "unknown", attempts = 1, ageMs = 0) => ({ status, attempts, updated_at: ago(ageMs) });

  it("decideClaim: calls are never re-dialed unless known not placed; obligations never re-sent on an unknown outcome; everything else is bounded", () => {
    const d = (kind: "email" | "call" | "text" | "a2a", key: string, r: ReturnType<typeof row>, underReview = false) => decideClaim({ kind, key, row: r, nowMs: T, staleMs: 120_000, underReview });
    expect(d("call", "call:j:b", row("pending", 1, 10_000))).toMatchObject({ action: "refuse" });
    expect(d("call", "call:j:b", row("pending", 1, 300_000))).toMatchObject({ action: "review" });
    expect(d("call", "call:j:b", row("unknown"))).toMatchObject({ action: "review" });
    expect(d("call", "call:j:b", row("sent"))).toMatchObject({ action: "refuse" });
    expect(d("call", "call:j:b", row("not_sent", 1))).toEqual({ action: "send", reclaim: true });
    expect(d("call", "call:j:b", row("not_sent", 3))).toMatchObject({ action: "review" });
    expect(d("email", "confirm:apr_1", row("pending", 1, 300_000))).toMatchObject({ action: "review" });
    expect(d("text", "handoff:apr_1", row("unknown"))).toMatchObject({ action: "review" });
    expect(d("email", "accept:apr_1", row("sent"))).toMatchObject({ action: "refuse" });
    expect(d("email", "accept:apr_1", row("not_sent", 1))).toEqual({ action: "send", reclaim: true });
    expect(d("email", "accept:apr_1", row("not_sent", 2))).toMatchObject({ action: "review" });
    expect(d("email", "rfq:j:b", row("sent"))).toEqual({ action: "send", reclaim: false });
    expect(d("email", "rfq:j:b", row("pending", 1, 10_000))).toMatchObject({ action: "defer" });
    expect(d("email", "rfq:j:b", row("pending", 1, 300_000))).toEqual({ action: "send", reclaim: true });
    expect(d("email", "rfq:j:b", row("not_sent", 5))).toMatchObject({ action: "review" });
    expect(d("email", "rfq:j:b", row("not_sent", 1), true)).toMatchObject({ action: "refuse" });
    expect(isObligationKey("imsg:approval:apr_1")).toBe(false);
  });

  it("decideChargeResume holds a charge past Stripe's idempotency window or after repeated failures; a release restarts both", () => {
    expect(decideChargeResume({ createdAt: ago(60_000), retries: 0, nowMs: T, underReview: false, releasedAt: null })).toEqual({ hold: false, released: false });
    expect(decideChargeResume({ createdAt: ago(21 * 3_600_000), retries: 0, nowMs: T, underReview: false, releasedAt: null })).toMatchObject({ hold: true });
    expect(decideChargeResume({ createdAt: ago(60_000), retries: 5, nowMs: T, underReview: false, releasedAt: null })).toMatchObject({ hold: true });
    expect(decideChargeResume({ createdAt: ago(21 * 3_600_000), retries: 0, nowMs: T, underReview: false, releasedAt: ago(1_000) })).toEqual({ hold: false, released: true });
    expect(decideChargeResume({ createdAt: ago(1_000), retries: 0, nowMs: T, underReview: true, releasedAt: null })).toMatchObject({ hold: true });
  });

  it("redactError strips addresses, numbers, keys, credentials in URLs and long tokens", () => {
    const r = redactError(new Error("send to orders@caterer.example failed (+1 (415) 555-0199) key sk_live_abc123 url postgres://u:pw@db.example/x?sslmode=require token abcdefghijklmnopqrstuvwxyz0123456789ABCD"));
    expect(r).not.toMatch(/caterer|555|sk_live|pw@|sslmode|abcdefghij/);
    expect(r.length).toBeLessThanOrEqual(300);
  });

  it("planRecovery: overdue work is advanced first, reviewed only when it stays stuck", () => {
    const base = { job: { id: "job_x", state: "collecting" as const, ready: false, collect_until: ago(10 * 60_000), created_at: ago(3_600_000), updated_at: ago(60_000) }, businesses: [], approval: null, payment: null, outbox: [], pendingMessages: 0 };
    expect(planRecovery(base, T)).toMatchObject([{ issue: "collection_overdue", action: "advance" }]);
    expect(planRecovery({ ...base, job: { ...base.job, collect_until: ago(40 * 60_000) } }, T)).toMatchObject([{ issue: "collection_overdue", action: "review" }]);
    expect(planRecovery({ ...base, job: { ...base.job, ready: true } }, T)).toEqual([]);
    const contacting = { ...base, job: { ...base.job, state: "contacting" as const, updated_at: ago(5 * 60_000) }, businesses: [{ business_id: "b", name: "Harbor", status: "pending" as const, next_attempt_at: null }] };
    expect(planRecovery(contacting, T)).toMatchObject([{ issue: "contacting_unsent", action: "advance" }]);
    const ob = (key: string, kind: "email" | "call", status: "pending" | "unknown" | "not_sent", attempts = 1) => ({ key, job_id: "job_x", kind, status, provider_ref: null, attempts, created_at: ago(600_000), updated_at: ago(600_000) });
    const f = planRecovery({ ...base, job: { ...base.job, ready: true }, outbox: [ob("call:job_x:b", "call", "pending"), ob("confirm:apr_1", "email", "pending"), ob("rfq:job_x:c", "email", "pending"), ob("followup:job_x:c:1", "email", "not_sent", 5), ob("call:job_x:d", "call", "unknown")] }, T);
    expect(f.map((x) => [x.subject, x.action])).toEqual([["call:job_x:b", "mark_unknown"], ["confirm:apr_1", "review"], ["rfq:job_x:c", "advance"], ["followup:job_x:c:1", "review"], ["call:job_x:d", "review"]]);
    const paid = { ...base, job: { ...base.job, state: "paid" as const, updated_at: ago(20 * 60_000) }, approval: { id: "apr_1", status: "used" as const, expires_at: ago(0), action: "pay" as const }, pendingMessages: 1 };
    expect(planRecovery(paid, T).map((x) => x.issue)).toEqual(["confirmation_not_sent", "late_reply"]);
  });
});
