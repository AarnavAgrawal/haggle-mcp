// End-to-end (MOCK MODE): the real engine, in-memory persistence, the simulated golden fleet and a
// controllable clock, from deal to a settled DEMO payment. Everything external is simulated and
// labelled; this proves the buyer workflow, not live Inkbox / Claude / x402 behaviour.
// v5 fleet (PLAN §8): Mission Eats only answers the phone, so its quote comes from a simulated
// Voice AI call transcript; every job shares one buyer mailbox, as with Inkbox.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockEngine, disabledPayer, EngineError, fleetBusinesses, GOLDEN_REQUEST, MOCK_BUYER_INBOX, PostgresRepository, type HaggleEngine, type Persona, type Repository } from "../src/index.ts";

// Runs against InMemoryRepository always, and against a real Postgres (migrations applied) when
// HAGGLE_TEST_DATABASE_URL is set: scripts/test-postgres.sh does that in a throwaway container.
const PG_URL = process.env.HAGGLE_TEST_DATABASE_URL;
const pgRepos: PostgresRepository[] = [];
afterAll(async () => { for (const r of pgRepos) await r.close(); });
let makeRepo: (() => Repository) | undefined;

function setup(extra: Partial<Parameters<typeof createMockEngine>[0]> = {}) {
  let t = Date.now(); // anchored to real time: the x402 SDK checks challenge expiry against the wall clock
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const m = createMockEngine({ now: clock.now, ...(makeRepo ? { repo: makeRepo() } : {}), ...extra });
  return { ...m, clock };
}

async function startDeal(engine: HaggleEngine) {
  const { budget_usd, ...request } = GOLDEN_REQUEST;
  return engine.deal({ request, budget_usd, businesses: fleetBusinesses().map((b) => ({ name: b.name, ...(b.email ? { email: b.email } : {}), ...(b.phone ? { phone: b.phone } : {}), source: "fleet" as const, simulated: true })) });
}

/** Advance simulated time until `done` holds, answering seller questions like an agent would. */
async function runUntil(engine: HaggleEngine, clock: { advance(ms: number): void }, jobId: string, done: (q: Awaited<ReturnType<HaggleEngine["getQuotes"]>>) => boolean) {
  let cursor = 0;
  for (let i = 0; i < 200; i++) {
    clock.advance(1_000);
    const w = await engine.waitForUpdate(jobId, cursor, 0);
    cursor = Number(w.cursor);
    const q = await engine.getQuotes(jobId);
    for (const pq of q.pending_questions) await engine.answerSeller(jobId, pq.question_id, "Yes, please include plates and cutlery for 40.");
    if (done(q)) return q;
  }
  throw new Error("scenario did not converge");
}

for (const backend of PG_URL ? ["memory", "postgres"] : ["memory"]) describe(`golden scenario, end to end (mock mode, ${backend})`, { timeout: 120_000 }, () => {
  beforeAll(() => {
    makeRepo = backend === "postgres" ? () => { const r = new PostgresRepository(PG_URL!, { max: 2 }); pgRepos.push(r); return r; } : undefined;
  });
  it("deal → replies → follow-up → question → negotiation → Bay $995 wins → approval → x402 → DEMO receipt", async () => {
    const { engine, fleet, clock, repo } = setup({ rail: "x402" }); // the v3 x402 rail (Stripe is covered in stripe.test.ts)
    const deal = await startDeal(engine);
    expect(deal).toMatchObject({ ok: true, mode: "mock", state: "collecting" });
    expect(deal.contacted).toHaveLength(6);
    expect(deal.inbox).toBe(MOCK_BUYER_INBOX);
    expect(deal.contacted.find((c) => c.business === "Mission Eats")).toMatchObject({ channel: "phone" });

    const ready = await runUntil(engine, clock, deal.job_id, (q) => q.ready);
    const bay = ready.quotes.find((q) => q.business === "Bay Catering")!;
    expect(ready.recommended_quote_id).toBe(bay.quote_id);
    expect(bay).toMatchObject({ total_usd: 995, negotiated_from: 1150, round: 2, deposit_usd: 5, meets_requirements: true, source: "quote.json" });
    const names = (id: string) => ready.business_names[id];
    expect(ready.rejected.map((r) => [names(r.business_id), r.reason])).toEqual(expect.arrayContaining([["Golden Grill", "requirement_unmet"], ["QuickQuote Deli", "external_payment_link"]]));
    const harbor = ready.quotes.find((q) => q.business === "Harbor Table")!;
    expect(harbor.flags).toContain("hidden_deposit");
    expect(harbor.total_usd).toBe(1008);
    expect(ready.quotes.find((q) => q.business === "Mission Eats")).toMatchObject({ total_usd: 1070, channel: "phone", source: "call transcript", deposit_usd: 50 });
    expect(fleet.calls).toHaveLength(1);
    expect(fleet.calls[0]!.reason).toMatch(/AI assistant/);
    expect(ready.quotes.find((q) => q.business === "Sunset Kitchen")!.total_usd).toBe(1180); // after answer_seller

    // Negotiation cited only real recorded quotes; the scam quote was never cited.
    const counters = fleet.sent.filter((s) => s.idempotencyKey.startsWith("counter:"));
    expect(counters.length).toBeGreaterThan(0);
    const quoteTotals = new Set((await repo.listQuotes(deal.job_id)).map((q) => q.total_cents));
    for (const c of counters) {
      const part = JSON.parse(new TextDecoder().decode(c.attachments![0]!.content));
      expect(quoteTotals.has(Math.round(part.target_total_usd * 100))).toBe(true);
      expect(part.target_total_usd).not.toBe(700);
      expect(c.bodyText).not.toMatch(/QuickQuote|Golden Grill/);
    }
    // Every outbound email has a unique idempotency key and goes to a pinned business address.
    expect(new Set(fleet.sent.map((s) => s.idempotencyKey)).size).toBe(fleet.sent.length);
    const pinned = new Set(fleetBusinesses().map((b) => b.email).filter(Boolean));
    for (const s of fleet.sent) expect(pinned.has(s.to)).toBe(true);

    // pay before approval is refused.
    await expect(engine.pay(deal.job_id, bay.quote_id)).rejects.toBeInstanceOf(EngineError);

    const approval = await engine.requestApproval(deal.job_id, bay.quote_id, "simulated");
    expect(approval).toMatchObject({ status: "pending", payment_cents: 500, quote_total_cents: 99500 });
    expect((await engine.pay(deal.job_id, bay.quote_id)).status).toBe("awaiting_approval");
    expect(await engine.decideApproval(approval.id, "approve", "simulated", "DEMO human")).toBe(true);
    expect((await repo.getJob(deal.job_id))!.state).toBe("paying");

    await engine.pay(deal.job_id, bay.quote_id);
    const paid = await runUntil(engine, clock, deal.job_id, (q) => q.state === "paid");
    expect(paid.payment).toMatchObject({ status: "settled", simulated: true, amount_usdc_base_units: "5000000", network: "base-sepolia" });
    expect(paid.payment!.settle_tx).toMatch(/^DEMO-/);
    expect(paid.payment!.explorer_url).toBeUndefined(); // never a fake explorer link
    const step = fleet.sent.find((s) => s.idempotencyKey.startsWith("pay:"))!;
    const env = JSON.parse(new TextDecoder().decode(step.attachments![0]!.content));
    expect(env).toMatchObject({ protocol: "x402.payment", step: "payment" });

    // The audit trail is ordered and complete.
    const types = (await repo.listEvents(deal.job_id)).map((e) => e.type);
    for (const t of ["question", "counteroffers_sent", "approval_requested", "approval_verified"]) expect(types).toContain(t);
    expect(types.filter((x) => x === "payment")).toHaveLength(5); // awaiting_invoice, invoice_received, signed, sent, settled
  });

  it("is idempotent: same client_request_id returns the same job and sends nothing new", async () => {
    const { engine, fleet } = setup();
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const input = { request, budget_usd, client_request_id: "agent-req-1", businesses: fleetBusinesses().slice(0, 2).map((b) => ({ name: b.name, email: b.email })) };
    const a = await engine.deal(input);
    const sent = fleet.sent.length;
    const b = await engine.deal(input);
    expect(b.job_id).toBe(a.job_id);
    expect(fleet.sent.length).toBe(sent);
  });

  it("refuses unsafe operations with fix hints", async () => {
    const { engine, clock } = setup();
    const deal = await startDeal(engine);
    const ready = await runUntil(engine, clock, deal.job_id, (q) => q.ready);
    const grill = ready.quotes.find((q) => q.business === "Golden Grill")!;
    await expect(engine.requestApproval(deal.job_id, grill.quote_id, "simulated")).rejects.toMatchObject({ code: "quote_not_eligible" });
    await expect(engine.answerSeller(deal.job_id, "qn_missing", "hi")).rejects.toMatchObject({ code: "question_not_found" });
    await expect(engine.deal({ request: { ...GOLDEN_REQUEST, requirements: [] }, businesses: [] })).rejects.toMatchObject({ code: "no_businesses" });
  });

  it("a revision after approval voids the approval (no payment for a changed quote)", async () => {
    const { engine, clock, repo } = setup({ rail: "x402" }); // $5 x402 cap
    const deal = await startDeal(engine);
    const ready = await runUntil(engine, clock, deal.job_id, (q) => q.ready);
    const harbor = ready.quotes.find((q) => q.business === "Harbor Table")!;
    // Harbor's deposit ($300) is over the $5 cap: refused before any human is asked.
    await expect(engine.requestApproval(deal.job_id, harbor.quote_id, "simulated")).rejects.toMatchObject({ code: "over_cap" });
    const bay = ready.quotes.find((q) => q.business === "Bay Catering")!;
    const approval = await engine.requestApproval(deal.job_id, bay.quote_id, "simulated");
    // A new Bay quote arrives (e.g. a mistake correction) before the human decides.
    const b = (await repo.getBusinesses(deal.job_id)).find((x) => x.name === "Bay Catering")!;
    await engine.ingest(
      { providerEventId: "e-rev", eventType: "email.received", providerEmailId: "rev-1", threadId: b.thread_id, messageId: "<rev-1@bay>", inReplyTo: [], references: [], from: b.email, to: [deal.inbox], subject: "Re: x", bodyText: "Correction: $1,050", attachments: [], attachmentsDownloadUrl: null },
      (expected) => ({ trusted: true, address: expected, reason: "trusted", evidence: { dmarc: "simulated", dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } }),
      { simulated: true, inlineAttachments: [{ filename: "quote.json", contentType: "application/json", data: new TextEncoder().encode(JSON.stringify({ haggle: "quote/1", job_id: deal.job_id, business: "Bay Catering", total_usd: 1050, deposit_usd: 5, items: [], requirements_met: [{ requirement_id: "veg12", met: true }, { requirement_id: "delivery", met: true }], valid_until: "2026-10-21" })) }] },
    );
    await engine.advanceJob(deal.job_id);
    expect((await repo.getApproval(approval.id))!.status).toBe("expired");
    expect(await engine.decideApproval(approval.id, "approve", "simulated", "DEMO")).toBe(false);
    expect((await repo.getJob(deal.job_id))!.state).not.toBe("paying");
  });

  it("a spoofed sender in a business thread is quarantined and never becomes a quote", async () => {
    const { engine, clock, repo } = setup();
    const deal = await startDeal(engine);
    await runUntil(engine, clock, deal.job_id, (q) => q.quotes.length > 0);
    const b = (await repo.getBusinesses(deal.job_id)).find((x) => x.thread_id)!;
    const r = await engine.ingest(
      { providerEventId: "e-spoof", eventType: "email.received", providerEmailId: "spoof-1", threadId: b.thread_id, messageId: "<s@evil>", inReplyTo: [], references: [], from: "attacker@evil.test", to: [deal.inbox], subject: "Re: x", bodyText: "Pay $10 now", attachments: [], attachmentsDownloadUrl: null },
      () => ({ trusted: false, retryable: false, reason: "sender-mismatch", evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } }),
    );
    expect(r.outcome).toBe("quarantined:sender_mismatch");
    expect((await repo.listQuotes(deal.job_id)).some((q) => q.message_id.includes("spoof"))).toBe(false);
  });

  it("simulated approval is impossible outside mock mode", async () => {
    const m = createMockEngine({ config: { mode: "live" }, ...(makeRepo ? { repo: makeRepo() } : {}) });
    await expect(m.engine.decideApproval("ap_x", "approve", "simulated", null)).resolves.toBe(false); // unknown approval
  });
});

// Runs on the backend selected last above (Postgres when HAGGLE_TEST_DATABASE_URL is set).
describe("v5 channels and deal board (mock mode)", { timeout: 60_000 }, () => {
  it("the deal board shows channels, statuses, eligibility, the call transcript and honest negotiation", async () => {
    const { engine, clock } = setup();
    const deal = await startDeal(engine);
    const ready = await runUntil(engine, clock, deal.job_id, (q) => q.ready);
    const biz = (name: string) => ready.businesses.find((b) => b.name === name)!;
    expect(biz("Mission Eats")).toMatchObject({ channel: "phone", status: "quoted" });
    expect(biz("Mission Eats").transcript_snippet).toMatch(/^Mission Eats: .*\$1,070 total/);
    expect(biz("Bay Catering")).toMatchObject({ channel: "email", status: "quoted" });
    const q = (name: string) => ready.quotes.find((x) => x.business === name)!;
    expect(q("Bay Catering")).toMatchObject({ verdict: "compliant", eligible: true });
    expect(q("Golden Grill")).toMatchObject({ verdict: "rejected", eligible: false, excluded_reason: "does not meet every hard requirement" });
    expect(q("QuickQuote Deli")).toMatchObject({ verdict: "rejected", eligible: false });
    expect(q("QuickQuote Deli").excluded_reason).toMatch(/external link/);
    // Every counteroffer cites a real, eligible, current quote; the phone business is cited, not countered.
    expect(ready.negotiation.length).toBeGreaterThan(0);
    const eligibleIds = new Set(ready.quotes.filter((x) => x.eligible).map((x) => x.quote_id));
    const allIds = new Set((await engine.getQuotes(deal.job_id)).quotes.map((x) => x.quote_id));
    for (const n of ready.negotiation) {
      expect(n.business).not.toBe("Mission Eats");
      expect(n.target_total_usd).toBe(1070); // Mission Eats' real phone quote was the best competing total
    }
    expect([...eligibleIds].every((id) => allIds.has(id))).toBe(true);
    expect(ready.negotiation.find((n) => n.business === "Bay Catering")).toMatchObject({ outcome_total_usd: 995 });
    expect(ready.job).toMatchObject({ id: deal.job_id, budget_usd: 1200 });
  });

  it("a phone-only business is reported unavailable (never contacted) when calls aren't enabled", async () => {
    const { engine, clock } = setup({ phone: false });
    const deal = await startDeal(engine);
    expect(deal.contacted).toHaveLength(5);
    expect(deal.not_contacted).toEqual([expect.objectContaining({ business: "Mission Eats", channel: "phone", reason: "phone calls are not enabled in this deployment" })]);
    const board = await runUntil(engine, clock, deal.job_id, (x) => x.ready);
    expect(board.businesses.find((b) => b.name === "Mission Eats")).toMatchObject({ status: "unavailable", channel: "phone" });
    expect(board.quotes.some((x) => x.business === "Mission Eats")).toBe(false);
    await expect(engine.deal({ request: GOLDEN_REQUEST, businesses: [{ name: "Phone only", phone: "+14155550199" }] })).rejects.toMatchObject({ code: "no_usable_channel" });
  });

  it("a vague emailed price gets one follow-up, never a guessed total", async () => {
    const vague: Persona = {
      name: "Vague Bistro", email: "hi@vague.sim.haggle.dev", delayMs: 1_000,
      reply(t) {
        if (t === "rfq") return { text: "~900ish lmk", extraction: { available: true, price_per_head_usd: null, headcount: 40, subtotal_usd: null, delivery_fee_usd: null, delivery_included: null, tax_usd: null, tax_included: true, total_usd: null, deposit_usd: null, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }], valid_until: null, questions: [], payment_request: "none", instructions_to_agent: false, sources: [], missing_fields: ["total"], confidence: 0.35 } };
        if (t === "followup") return { text: "$1,070 total delivered, $50 deposit.", extraction: { available: true, price_per_head_usd: null, headcount: 40, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true, total_usd: 1070, deposit_usd: 50, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }], valid_until: null, questions: [], payment_request: "none", instructions_to_agent: false, sources: [{ field: "total", source: "email body", excerpt: "$1,070 total" }], missing_fields: [], confidence: 0.9 } };
        return null;
      },
    };
    const { engine, fleet, clock } = setup({ personas: [vague] });
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: vague.name, email: vague.email }] });
    const ready = await runUntil(engine, clock, deal.job_id, (x) => x.ready);
    expect(fleet.sent.filter((s) => s.idempotencyKey.startsWith("followup:"))).toHaveLength(1);
    expect(ready.quotes).toEqual([expect.objectContaining({ total_usd: 1070, verdict: "compliant" })]);
  });

  it("deal validates contacts and refuses Haggle's own mailbox", async () => {
    const { engine } = setup();
    await expect(engine.deal({ request: GOLDEN_REQUEST, businesses: [{ name: "X", phone: "415-555-0100" }] })).rejects.toMatchObject({ code: "bad_phone" });
    await expect(engine.deal({ request: GOLDEN_REQUEST, businesses: [{ name: "X" }] })).rejects.toMatchObject({ code: "no_contact" });
    await expect(engine.deal({ request: GOLDEN_REQUEST, businesses: [{ name: "Me", email: MOCK_BUYER_INBOX }] })).rejects.toMatchObject({ code: "bad_email" });
  });

  it("settings: cap ceiling enforced; launcher returns the newest open job; view approval needs the code", async () => {
    const { engine, clock } = setup();
    expect((await engine.getSettings()).spending_cap_cents).toBe(150_000);
    await expect(engine.updateSettings({ spending_cap_cents: 10_000_000 })).rejects.toMatchObject({ code: "cap_above_ceiling" });
    expect((await engine.updateSettings({ spending_cap_cents: 120_000, default_area: "San Francisco, CA" })).default_area).toBe("San Francisco, CA");
    if (!makeRepo) expect(await engine.latestJob()).toBeNull(); // a fresh memory store has no jobs (Postgres is shared by tests)
    const deal = await startDeal(engine);
    const latest = (await engine.latestJob())!;
    if (makeRepo) {
      // Shared Postgres: other tests' jobs share this fake clock's start, so assert the rule, not the id.
      const mine = (await engine.loadJob(deal.job_id)) as { created_at: string };
      expect(Date.parse((latest as { created_at: string }).created_at)).toBeGreaterThanOrEqual(Date.parse(mine.created_at));
      expect(["paid", "cancelled", "failed"]).not.toContain(latest.state);
    } else expect(latest.id).toBe(deal.job_id);
    const ready = await runUntil(engine, clock, deal.job_id, (x) => x.ready);
    const bay = ready.quotes.find((x) => x.business === "Bay Catering")!;
    const a = await engine.requestApproval(deal.job_id, bay.quote_id, "view");
    await expect(engine.approveWithViewCode(a.id, a.code === "0000" ? "1111" : "0000")).rejects.toMatchObject({ code: "bad_code" });
    expect((await engine.approveWithViewCode(a.id, a.code)).status).toBe("approved");
    expect((await engine.getQuotes(deal.job_id)).businesses.find((b) => b.name === "Bay Catering")!.status).toBe("won");
  });
});

describe("recipient allowlist (live safety)", () => {
  it("deal refuses businesses that aren't explicitly allowed", async () => {
    const { engine, fleet } = setup({ config: { recipientAllowlist: ["quotes@bay-catering.sim.haggle.dev", "@harbor-table.sim.haggle.dev", "+14155550104"] } });
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    await expect(engine.deal({ request, budget_usd, businesses: [{ name: "Real Diner", email: "owner@realdiner.example" }] })).rejects.toMatchObject({ code: "recipient_not_allowed" });
    expect(fleet.sent).toHaveLength(0);
    const ok = await engine.deal({ request, budget_usd, businesses: [{ name: "Bay Catering", email: "quotes@bay-catering.sim.haggle.dev" }, { name: "Harbor Table", email: "orders@harbor-table.sim.haggle.dev" }, { name: "Mission Eats", phone: "+14155550104" }] });
    expect(ok.contacted).toHaveLength(3);
  });

  it("with payments disabled (live v5 until Stripe), approval sends no x402 accept email and the payment is refused, never faked", async () => {
    const { engine, fleet, clock, repo } = setup({ payer: disabledPayer("Payments are not enabled yet") });
    const deal = await startDeal(engine);
    const ready = await runUntil(engine, clock, deal.job_id, (q) => q.ready);
    const bay = ready.quotes.find((q) => q.business === "Bay Catering")!;
    const approval = await engine.requestApproval(deal.job_id, bay.quote_id, "simulated");
    expect(await engine.decideApproval(approval.id, "approve", "simulated", "DEMO human")).toBe(true);
    await engine.advanceJob(deal.job_id);
    expect(fleet.sent.filter((s) => s.idempotencyKey.startsWith("accept:"))).toHaveLength(0);
    const board = await engine.getQuotes(deal.job_id);
    expect(board.payment).toMatchObject({ status: "failed", simulated: false, reason: "Payments are not enabled yet" });
    expect((await repo.getJob(deal.job_id))!).toMatchObject({ state: "failed", failure_reason: "payment_failed" });
    await expect(engine.pay(deal.job_id, bay.quote_id)).rejects.toMatchObject({ code: "not_payable" });
  });
});
