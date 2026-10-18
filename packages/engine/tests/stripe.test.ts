// Stripe test-mode rail: the port (fake fetch, no network), the pure guard, and the engine flow on
// the simulated rail (mock mode): exact-quote human approval, caps, verified payee, idempotency,
// resumable retries, safe refusals. No real or test-mode charge is ever made here.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkStripePaymentAllowed, createMockEngine, fleetBusinesses, GOLDEN_REQUEST, PostgresRepository, simulatedStripe, stripeTestPayments, validateStripeTestConfig, verifyStripeTestSetup,
  type HaggleEngine, type Repository, type StripeChargeRequest, type StripeChargeResult, type StripePort,
} from "../src/index.ts";

const CFG = { secretKey: "sk_test_FAKEFAKEFAKE", customerId: "cus_TEST123", paymentMethodId: "pm_card_visa_TEST" }; // fake ids gitleaks:allow

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
function fakeFetch(respond: (c: Call) => { status: number; json: unknown } | Error) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const c: Call = { url, method: init.method ?? "GET", headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])), body: String(init.body ?? "") };
    calls.push(c);
    const r = respond(c);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.json), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const REQ: StripeChargeRequest = { amountCents: 500, idempotencyKey: "haggle-pay-ap_1", description: "Haggle deposit", metadata: { job_id: "job_1", approval_id: "ap_1", quote_id: "q_1", business_id: "biz_1", business: "Bay Catering" } };
/** A succeeded test-mode PaymentIntent that matches REQ exactly. */
const PI = { id: "pi_123", status: "succeeded", livemode: false, amount: 500, amount_received: 500, currency: "usd", customer: "cus_TEST123", metadata: { approval_id: "ap_1", quote_id: "q_1", job_id: "job_1" } };

describe("Stripe test-mode port", () => {
  it("refuses anything but a test key and well-formed ids", () => {
    expect(validateStripeTestConfig({ ...CFG, secretKey: "sk_live_x" })).toMatch(/test-mode/);
    expect(validateStripeTestConfig({ ...CFG, secretKey: "rk_test_x" })).toMatch(/test-mode/);
    expect(validateStripeTestConfig({ ...CFG, customerId: "bob" })).toMatch(/cus_/);
    expect(validateStripeTestConfig({ ...CFG, paymentMethodId: "4242424242424242" })).toMatch(/pm_/);
    expect(() => stripeTestPayments({ ...CFG, secretKey: "sk_live_x" })).toThrow(/test-mode/);
    expect(validateStripeTestConfig(CFG)).toBeNull();
  });

  it("charges the approved amount once per idempotency key, test mode only", async () => {
    const { f, calls } = fakeFetch(() => ({ status: 200, json: PI }));
    const r = await stripeTestPayments({ ...CFG, fetchImpl: f }).charge(REQ);
    expect(r).toEqual({ ok: true, paymentIntentId: "pi_123" });
    expect(calls).toHaveLength(2); // the charge, then the independent read-back
    const c = calls[0]!;
    expect(c).toMatchObject({ url: "https://api.stripe.com/v1/payment_intents", method: "POST" });
    expect(c.headers["idempotency-key"]).toBe("haggle-pay-ap_1");
    expect(c.headers.authorization).toBe(`Bearer ${CFG.secretKey}`);
    const body = new URLSearchParams(c.body);
    expect(Object.fromEntries(["amount", "currency", "customer", "payment_method", "confirm", "off_session"].map((k) => [k, body.get(k)])))
      .toEqual({ amount: "500", currency: "usd", customer: "cus_TEST123", payment_method: "pm_card_visa_TEST", confirm: "true", off_session: "true" });
    expect(body.get("metadata[approval_id]")).toBe("ap_1");
  });

  it("treats a live-mode response, declines and request errors as final; network/5xx/409 as retryable", async () => {
    const charge = (status: number, json: unknown) => stripeTestPayments({ ...CFG, fetchImpl: fakeFetch(() => ({ status, json })).f }).charge(REQ);
    expect(await charge(200, { id: "pi_live", status: "succeeded", livemode: true })).toMatchObject({ ok: false, reason: "not_test_mode", retryable: false });
    expect(await charge(402, { error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", payment_intent: { id: "pi_d" } } })).toEqual({ ok: false, reason: "insufficient_funds", retryable: false, paymentIntentId: "pi_d" });
    expect(await charge(400, { error: { type: "invalid_request_error", code: "resource_missing" } })).toMatchObject({ ok: false, reason: "resource_missing", retryable: false });
    expect(await charge(500, { error: { type: "api_error" } })).toMatchObject({ ok: false, retryable: true });
    expect(await charge(409, { error: { type: "idempotency_error" } })).toMatchObject({ ok: false, retryable: true });
    expect(await charge(200, { id: "pi_p", status: "processing", livemode: false })).toMatchObject({ ok: false, reason: "processing", retryable: true });
    expect(await stripeTestPayments({ ...CFG, fetchImpl: fakeFetch(() => new Error("ECONNRESET")).f }).charge(REQ)).toEqual({ ok: false, reason: "stripe_unreachable", retryable: true });
  });

  it("confirms every charge with an independent GET before calling it paid; a mismatch is final, an unreachable check retries", async () => {
    const charge = (get: (c: Call) => { status: number; json: unknown } | Error) =>
      stripeTestPayments({ ...CFG, fetchImpl: fakeFetch((c) => (c.method === "POST" ? { status: 200, json: PI } : get(c))).f }).charge(REQ);
    const { f, calls } = fakeFetch((c) => (c.method === "POST" ? { status: 200, json: PI } : { status: 200, json: PI }));
    expect(await stripeTestPayments({ ...CFG, fetchImpl: f }).charge(REQ)).toEqual({ ok: true, paymentIntentId: "pi_123" });
    expect(calls[1]).toMatchObject({ method: "GET", url: "https://api.stripe.com/v1/payment_intents/pi_123?expand[]=latest_charge" });
    // Stripe's hosted receipt (no Stripe login needed) comes from the same read-back; anything else is ignored.
    const withReceipt = await charge(() => ({ status: 200, json: { ...PI, latest_charge: { receipt_url: "https://pay.stripe.com/receipts/payment/abc" } } }));
    expect(withReceipt).toEqual({ ok: true, paymentIntentId: "pi_123", receiptUrl: "https://pay.stripe.com/receipts/payment/abc" });
    expect(await charge(() => ({ status: 200, json: { ...PI, latest_charge: { receipt_url: "https://evil.example/receipt" } } }))).toEqual({ ok: true, paymentIntentId: "pi_123" });
    for (const [field, value] of [["amount", 5000], ["amount_received", 0], ["currency", "eur"], ["status", "requires_action"], ["livemode", true], ["customer", "cus_OTHER"], ["metadata", { approval_id: "ap_2", quote_id: "q_1" }]] as const) {
      expect(await charge(() => ({ status: 200, json: { ...PI, [field]: value } })), field).toMatchObject({ ok: false, reason: expect.stringMatching(/^verification_failed/), retryable: false, paymentIntentId: "pi_123" });
    }
    expect(await charge(() => new Error("ECONNRESET"))).toMatchObject({ ok: false, reason: "verification_unavailable", retryable: true, paymentIntentId: "pi_123" });
    expect(await charge(() => ({ status: 503, json: {} }))).toMatchObject({ ok: false, reason: "verification_unavailable", retryable: true });
  });

  it("verifyStripeTestSetup only reads (GET), and checks the card belongs to the customer", async () => {
    const { f, calls } = fakeFetch((c) => c.url.includes("/customers/")
      ? { status: 200, json: { id: "cus_TEST123", livemode: false } }
      : { status: 200, json: { id: "pm_card_visa_TEST", customer: "cus_TEST123", livemode: false, type: "card", card: { brand: "visa", last4: "4242" } } });
    const v = await verifyStripeTestSetup({ ...CFG, fetchImpl: f });
    expect(v.ok).toBe(true);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    const other = await verifyStripeTestSetup({ ...CFG, fetchImpl: fakeFetch((c) => c.url.includes("/customers/") ? { status: 200, json: { livemode: false } } : { status: 200, json: { customer: "cus_SOMEONEELSE", livemode: false } }).f });
    expect(other.ok).toBe(false);
  });
});

describe("checkStripePaymentAllowed (pure)", () => {
  // One fixed clock: the old test read the wall clock twice (base().now, then Date.now() - 1 for the
  // expired case) and flaked under parallel load when more than 1 ms passed between the two reads.
  const NOW = new Date("2026-10-18T03:00:00.000Z");
  const base = () => ({
    stripeConfigured: true,
    job: { id: "j", state: "paying" },
    approval: { id: "ap", job_id: "j", quote_id: "q", business_id: "b", quote_total_cents: 99500, payment_cents: 500, status: "approved", expires_at: new Date(NOW.getTime() + 60_000).toISOString() },
    quote: { id: "q", business_id: "b", total_cents: 99500, deposit_cents: 500, status: "current" },
    payee: { business_id: "b", on_job: true, quoted_from_trusted_sender: true },
    existingPayment: null as { id: string; status: string } | null,
    spendCapCents: 50_000,
    now: NOW,
  });
  it("passes only for the exact approved quote, amount and quoting payee under the cap", () => {
    expect(checkStripePaymentAllowed(base())).toEqual({ ok: true });
    const cases: [string, ReturnType<typeof base>][] = [
      ["PAYMENT_DISABLED", { ...base(), stripeConfigured: false }],
      ["APPROVAL_NOT_FOUND", { ...base(), approval: null as never }],
      ["APPROVAL_PENDING", { ...base(), approval: { ...base().approval, status: "pending" } }],
      ["APPROVAL_DECLINED", { ...base(), approval: { ...base().approval, status: "declined" } }],
      ["APPROVAL_EXPIRED", { ...base(), approval: { ...base().approval, status: "used" } }],
      ["APPROVAL_EXPIRED", { ...base(), approval: { ...base().approval, expires_at: new Date(NOW.getTime() - 1).toISOString() } }],
      ["APPROVAL_EXPIRED", { ...base(), approval: { ...base().approval, expires_at: NOW.toISOString() } }], // the boundary instant is expired
      ["QUOTE_CHANGED", { ...base(), quote: { ...base().quote, status: "superseded" } }],
      ["QUOTE_CHANGED", { ...base(), quote: { ...base().quote, id: "q2" } }],
      ["AMOUNT_MISMATCH", { ...base(), quote: { ...base().quote, deposit_cents: 600 } }],
      ["OVER_SPEND_CAP", { ...base(), spendCapCents: 499 }],
      ["JOB_NOT_READY", { ...base(), job: { id: "j", state: "awaiting_approval" } }],
      ["PAYEE_NOT_QUOTED", { ...base(), payee: { business_id: "b", on_job: true, quoted_from_trusted_sender: false } }],
      ["PAYEE_NOT_QUOTED", { ...base(), payee: null as never }],
      ["PAYMENT_IN_FLIGHT", { ...base(), existingPayment: { id: "p", status: "charging" } }],
    ];
    for (const [code, input] of cases) expect(checkStripePaymentAllowed(input), code).toMatchObject({ ok: false, code });
    expect(checkStripePaymentAllowed({ ...base(), existingPayment: { id: "p", status: "settled" } })).toMatchObject({ ok: true, existingPayment: { id: "p" } });
  });
});

// Engine flows on the simulated Stripe rail (memory always; Postgres when HAGGLE_TEST_DATABASE_URL is set).
const PG_URL = process.env.HAGGLE_TEST_DATABASE_URL;
const pgRepos: PostgresRepository[] = [];
afterAll(async () => { for (const r of pgRepos) await r.close(); });

/** A port that records every call and answers from a script (default: success). */
function scriptedStripe(script: StripeChargeResult[] = []): StripePort & { calls: StripeChargeRequest[] } {
  const calls: StripeChargeRequest[] = [];
  // PaymentIntent ids are unique (as Stripe's are): tests share one Postgres, whose unique index would otherwise refuse the settle.
  const run = Math.random().toString(36).slice(2, 10);
  return { simulated: true, calls, async charge(req) { calls.push(req); return script.shift() ?? { ok: true, paymentIntentId: `pi_DEMO${run}${calls.length}` }; } };
}

for (const backend of PG_URL ? ["memory", "postgres"] : ["memory"]) describe(`engine on the Stripe rail (mock, ${backend})`, { timeout: 60_000 }, () => {
  let makeRepo: (() => Repository) | undefined;
  beforeAll(() => { makeRepo = backend === "postgres" ? () => { const r = new PostgresRepository(PG_URL!, { max: 2 }); pgRepos.push(r); return r; } : undefined; });

  function setup(stripe: StripePort = simulatedStripe(), config = {}) {
    let t = Date.now();
    const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
    const m = createMockEngine({ now: clock.now, stripe, config, ...(makeRepo ? { repo: makeRepo() } : {}) });
    return { ...m, clock };
  }
  async function ready(engine: HaggleEngine, clock: { advance(ms: number): void }) {
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await engine.deal({ request, budget_usd, businesses: fleetBusinesses().map((b) => ({ name: b.name, ...(b.email ? { email: b.email } : {}), ...(b.phone ? { phone: b.phone } : {}), simulated: true })) });
    let cursor = 0;
    for (let i = 0; i < 200; i++) {
      clock.advance(1_000);
      cursor = Number((await engine.waitForUpdate(deal.job_id, cursor, 0)).cursor);
      const q = await engine.getQuotes(deal.job_id);
      for (const pq of q.pending_questions) await engine.answerSeller(deal.job_id, pq.question_id, "Yes, plates for 40.");
      if (q.ready) return { deal, board: q };
    }
    throw new Error("did not converge");
  }

  it("human approval of the exact quote → one test-mode charge of the approved deposit → paid", async () => {
    const stripe = scriptedStripe();
    const { engine, clock, fleet, repo } = setup(stripe);
    const { deal, board } = await ready(engine, clock);
    const bay = board.quotes.find((q) => q.business === "Bay Catering")!;
    await expect(engine.pay(deal.job_id, bay.quote_id)).rejects.toMatchObject({ code: "no_approval" });
    const a = await engine.requestApproval(deal.job_id, bay.quote_id, "simulated");
    expect(await engine.pay(deal.job_id, bay.quote_id)).toMatchObject({ status: "awaiting_approval", rail: "stripe" });
    expect(stripe.calls).toHaveLength(0); // nothing charged before the human decides
    await engine.decideApproval(a.id, "approve", "simulated", "DEMO human");
    expect(stripe.calls).toHaveLength(0); // approval alone charges nothing
    expect(fleet.sent.some((s) => s.idempotencyKey.startsWith("accept:"))).toBe(false); // no x402 invoice request email
    const p = await engine.pay(deal.job_id, bay.quote_id);
    expect(p).toMatchObject({ status: "settled", rail: "stripe", network: "stripe-test", amount_usd: 5, payment_intent_id: expect.stringMatching(/^pi_DEMO[a-z0-9]+1$/), simulated: true });
    expect(p.receipt_url).toBeUndefined(); // never a dashboard link for a simulated charge
    expect(stripe.calls).toEqual([expect.objectContaining({ amountCents: 500, idempotencyKey: `haggle-pay-${a.id}`, metadata: expect.objectContaining({ approval_id: a.id, quote_id: bay.quote_id, business: "Bay Catering" }) })]);
    expect((await repo.getJob(deal.job_id))!.state).toBe("paid");
    expect((await repo.getApproval(a.id))!.status).toBe("used");
    // Paying again is an idempotent no-op: still exactly one charge.
    expect(await engine.pay(deal.job_id, bay.quote_id)).toMatchObject({ status: "settled" });
    expect(stripe.calls).toHaveLength(1);
    expect((await engine.getQuotes(deal.job_id)).businesses.find((b) => b.name === "Bay Catering")!.status).toBe("won");
  });

  it("concurrent pay calls charge once", async () => {
    const stripe = scriptedStripe();
    const { engine, clock } = setup(stripe);
    const { deal, board } = await ready(engine, clock);
    const bay = board.quotes.find((q) => q.business === "Bay Catering")!;
    const a = await engine.requestApproval(deal.job_id, bay.quote_id, "simulated");
    await engine.decideApproval(a.id, "approve", "simulated", "DEMO human");
    await Promise.allSettled([engine.pay(deal.job_id, bay.quote_id), engine.pay(deal.job_id, bay.quote_id), engine.pay(deal.job_id, bay.quote_id)]);
    expect(stripe.calls).toHaveLength(1);
  });

  it("refuses safely: over the settings cap at approval, a revised quote, and a final decline (no retry)", async () => {
    // Operator per-payment ceiling $100 → Harbor's $300 deposit can't even be sent for approval.
    // (The settings spending cap is the human's preference: a caveat, see approvalCaveats.test.ts.)
    const s1 = setup(scriptedStripe(), { globalPaymentCapCents: 10_000 });
    const r1 = await ready(s1.engine, s1.clock);
    const harbor = r1.board.quotes.find((q) => q.business === "Harbor Table")!;
    await expect(s1.engine.requestApproval(r1.deal.job_id, harbor.quote_id, "simulated")).rejects.toMatchObject({ code: "over_cap" });

    // A decline is final: payment failed with the code, job failed, exactly one attempt.
    const stripe = scriptedStripe([{ ok: false, reason: "card_declined", retryable: false }]);
    const s2 = setup(stripe);
    const r2 = await ready(s2.engine, s2.clock);
    const bay = r2.board.quotes.find((q) => q.business === "Bay Catering")!;
    const a = await s2.engine.requestApproval(r2.deal.job_id, bay.quote_id, "simulated");
    await s2.engine.decideApproval(a.id, "approve", "simulated", "DEMO human");
    expect(await s2.engine.pay(r2.deal.job_id, bay.quote_id)).toMatchObject({ status: "failed", reason: "card_declined" });
    await s2.engine.pay(r2.deal.job_id, bay.quote_id).catch(() => undefined);
    expect(stripe.calls).toHaveLength(1);
    expect((await s2.repo.getJob(r2.deal.job_id))!.state).toBe("failed");
  });

  it("a revised quote after approval is never charged", async () => {
    const stripe = scriptedStripe();
    const { engine, clock, repo } = setup(stripe);
    const { deal, board } = await ready(engine, clock);
    const bay = board.quotes.find((q) => q.business === "Bay Catering")!;
    const a = await engine.requestApproval(deal.job_id, bay.quote_id, "simulated");
    await engine.decideApproval(a.id, "approve", "simulated", "DEMO human");
    const b = (await repo.getBusinesses(deal.job_id)).find((x) => x.name === "Bay Catering")!;
    await engine.ingest(
      { providerEventId: `e-rev-${deal.job_id}`, eventType: "email.received", providerEmailId: `stripe-rev-${deal.job_id}`, threadId: b.thread_id, messageId: `<stripe-rev-${deal.job_id}@bay>`, inReplyTo: [], references: [], from: b.email, to: [deal.inbox], subject: "Re: x", bodyText: "Correction: $1,050", attachments: [], attachmentsDownloadUrl: null },
      (expected) => ({ trusted: true, address: expected, reason: "trusted", evidence: { dmarc: "simulated", dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } }),
      { simulated: true, inlineAttachments: [{ filename: "quote.json", contentType: "application/json", data: new TextEncoder().encode(JSON.stringify({ haggle: "quote/1", job_id: deal.job_id, business: "Bay Catering", total_usd: 1050, deposit_usd: 5, items: [], requirements_met: [{ requirement_id: "veg12", met: true }, { requirement_id: "delivery", met: true }], valid_until: "2026-10-21" })) }] },
    );
    await engine.advanceJob(deal.job_id);
    await expect(engine.pay(deal.job_id, bay.quote_id)).rejects.toMatchObject({ code: expect.stringMatching(/^(approval_expired|payment_refused_quote_changed|not_payable)$/) });
    expect(stripe.calls).toHaveLength(0);
  });

  // A revision while the human is deciding voids the approval: nothing to approve, pay or charge.
  it("a quote revised while the human is deciding voids the approval: the late approval and pay charge nothing", async () => {
    const stripe = scriptedStripe();
    const { engine, clock, repo } = setup(stripe);
    const { deal, board } = await ready(engine, clock);
    const bay = board.quotes.find((q) => q.business === "Bay Catering")!;
    const a = await engine.requestApproval(deal.job_id, bay.quote_id, "simulated");
    const b = (await repo.getBusinesses(deal.job_id)).find((x) => x.name === "Bay Catering")!;
    await engine.ingest(
      { providerEventId: `e-rev-pending-${deal.job_id}`, eventType: "email.received", providerEmailId: `stripe-rev-pending-${deal.job_id}`, threadId: b.thread_id, messageId: `<stripe-rev-pending-${deal.job_id}@bay>`, inReplyTo: [], references: [], from: b.email, to: [deal.inbox], subject: "Re: x", bodyText: "Correction: $1,050", attachments: [], attachmentsDownloadUrl: null },
      (expected) => ({ trusted: true, address: expected, reason: "trusted", evidence: { dmarc: "simulated", dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } }),
      { simulated: true, inlineAttachments: [{ filename: "quote.json", contentType: "application/json", data: new TextEncoder().encode(JSON.stringify({ haggle: "quote/1", job_id: deal.job_id, business: "Bay Catering", total_usd: 1050, deposit_usd: 6, items: [], requirements_met: [{ requirement_id: "veg12", met: true }, { requirement_id: "delivery", met: true }], valid_until: "2026-10-21" })) }] },
    );
    await engine.advanceJob(deal.job_id);
    expect((await repo.getApproval(a.id))!.status).toBe("expired");
    expect(await engine.decideApproval(a.id, "approve", "simulated", "DEMO human")).toBe(false);
    await expect(engine.pay(deal.job_id, bay.quote_id)).rejects.toMatchObject({ code: expect.stringMatching(/^(approval_expired|payment_refused_quote_changed|not_payable|no_approval)$/) });
    expect(stripe.calls).toHaveLength(0);
  });

  it("a price cut flows through everywhere: the board compares the revised quote, the stale approval is refused, and the new approval and Stripe charge use the new amounts", async () => {
    const stripe = scriptedStripe();
    const { engine, clock, repo } = setup(stripe);
    const { deal, board } = await ready(engine, clock);
    const bay = board.quotes.find((q) => q.business === "Bay Catering")!;
    expect(bay).toMatchObject({ total_usd: 995, deposit_usd: 5 });
    const stale = await engine.requestApproval(deal.job_id, bay.quote_id, "simulated");
    await engine.decideApproval(stale.id, "approve", "simulated", "DEMO human");
    const b = (await repo.getBusinesses(deal.job_id)).find((x) => x.name === "Bay Catering")!;
    await engine.ingest(
      { providerEventId: `e-cut-${deal.job_id}`, eventType: "email.received", providerEmailId: `stripe-cut-${deal.job_id}`, threadId: b.thread_id, messageId: `<stripe-cut-${deal.job_id}@bay>`, inReplyTo: [], references: [], from: b.email, to: [deal.inbox], subject: "Re: x", bodyText: "We can do $950, deposit $4.", attachments: [], attachmentsDownloadUrl: null },
      (expected) => ({ trusted: true, address: expected, reason: "trusted", evidence: { dmarc: "simulated", dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } }),
      { simulated: true, inlineAttachments: [{ filename: "quote.json", contentType: "application/json", data: new TextEncoder().encode(JSON.stringify({ haggle: "quote/1", job_id: deal.job_id, business: "Bay Catering", total_usd: 950, deposit_usd: 4, items: [], requirements_met: [{ requirement_id: "veg12", met: true }, { requirement_id: "delivery", met: true }], valid_until: "2026-10-21" })) }] },
    );
    await engine.advanceJob(deal.job_id);
    // The stale approval (for $995) can't pay the $950 version, and nothing is charged.
    await expect(engine.pay(deal.job_id, bay.quote_id)).rejects.toBeTruthy();
    expect(stripe.calls).toHaveLength(0);
    // The board compares the revised quote, shows where it came from, and recommends it.
    const after = await engine.getQuotes(deal.job_id);
    const cut = after.quotes.find((q) => q.business === "Bay Catering")!;
    expect(cut.quote_id).not.toBe(bay.quote_id);
    expect(cut).toMatchObject({ total_usd: 950, deposit_usd: 4, negotiated_from: 995 });
    expect(after.recommended_quote_id).toBe(cut.quote_id);
    expect(after.approval?.status ?? "none").not.toBe("approved");
    // A fresh approval of the new version, and the charge Stripe receives, are the new numbers.
    const fresh = await engine.requestApproval(deal.job_id, cut.quote_id, "simulated");
    expect(fresh.payment_cents).toBe(400);
    await engine.decideApproval(fresh.id, "approve", "simulated", "DEMO human");
    expect(await engine.pay(deal.job_id, cut.quote_id)).toMatchObject({ status: "settled", amount_usd: 4 });
    expect(stripe.calls).toHaveLength(1);
    expect(stripe.calls[0]).toMatchObject({ amountCents: 400, idempotencyKey: `haggle-pay-${fresh.id}`, metadata: expect.objectContaining({ quote_id: cut.quote_id, approval_id: fresh.id }) });
  });

  it("a retryable error leaves the charge resumable under the same key; the next advance settles it", async () => {
    // pay() itself retries once (it advances right after the first attempt); two failures leave it charging.
    const stripe = scriptedStripe([{ ok: false, reason: "stripe_unreachable", retryable: true }, { ok: false, reason: "stripe_http_503", retryable: true }]);
    const { engine, clock, repo } = setup(stripe);
    const { deal, board } = await ready(engine, clock);
    const bay = board.quotes.find((q) => q.business === "Bay Catering")!;
    const a = await engine.requestApproval(deal.job_id, bay.quote_id, "simulated");
    await engine.decideApproval(a.id, "approve", "simulated", "DEMO human");
    expect(await engine.pay(deal.job_id, bay.quote_id)).toMatchObject({ status: "charging" });
    await engine.advanceJob(deal.job_id);
    expect(stripe.calls.map((c) => c.idempotencyKey)).toEqual([`haggle-pay-${a.id}`, `haggle-pay-${a.id}`, `haggle-pay-${a.id}`]);
    expect((await repo.getPaymentForJob(deal.job_id))!.status).toBe("settled");
    expect((await repo.getJob(deal.job_id))!.state).toBe("paid");
  });
});
