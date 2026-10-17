// End-to-end (MOCK MODE): the real engine, in-memory persistence, the simulated golden fleet and a
// controllable clock, from deal to a settled DEMO payment. Everything external is simulated and
// labelled; this proves the buyer workflow, not live Primitive / Claude / x402 behaviour.
import { describe, expect, it } from "vitest";
import { createMockEngine, EngineError, fleetBusinesses, GOLDEN_REQUEST, type HaggleEngine } from "../src/index.ts";

function setup() {
  let t = Date.parse("2026-10-17T18:00:00Z");
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const m = createMockEngine({ now: clock.now });
  return { ...m, clock };
}

async function startDeal(engine: HaggleEngine) {
  const { budget_usd, ...request } = GOLDEN_REQUEST;
  return engine.deal({ request, budget_usd, businesses: fleetBusinesses().map((b) => ({ name: b.name, email: b.email, source: "fleet", simulated: true })) });
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

describe("golden scenario, end to end (mock mode)", () => {
  it("deal → replies → follow-up → question → negotiation → Bay $995 wins → approval → x402 → DEMO receipt", async () => {
    const { engine, fleet, clock, repo } = setup();
    const deal = await startDeal(engine);
    expect(deal).toMatchObject({ ok: true, mode: "mock", state: "collecting" });
    expect(deal.contacted).toHaveLength(6);
    expect(deal.inbox).toMatch(/^job-[a-z0-9]{4}@mock\.haggle\.dev$/);

    const ready = await runUntil(engine, clock, deal.job_id, (q) => q.ready);
    const bay = ready.quotes.find((q) => q.business === "Bay Catering")!;
    expect(ready.recommended_quote_id).toBe(bay.quote_id);
    expect(bay).toMatchObject({ total_usd: 995, negotiated_from: 1150, round: 2, deposit_usd: 5, meets_requirements: true, source: "quote.json" });
    const names = (id: string) => ready.business_names[id];
    expect(ready.rejected.map((r) => [names(r.business_id), r.reason])).toEqual(expect.arrayContaining([["Golden Grill", "requirement_unmet"], ["QuickQuote Deli", "external_payment_link"]]));
    const harbor = ready.quotes.find((q) => q.business === "Harbor Table")!;
    expect(harbor.flags).toContain("hidden_deposit");
    expect(harbor.total_usd).toBe(1008);
    expect(ready.quotes.find((q) => q.business === "Mission Eats")!.total_usd).toBe(1070); // after the follow-up, never from "~900ish"
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
    const pinned = new Set(fleetBusinesses().map((b) => b.email));
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
    const { engine, clock, repo } = setup();
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
    const m = createMockEngine({ config: { mode: "live" } });
    await expect(m.engine.decideApproval("ap_x", "approve", "simulated", null)).resolves.toBe(false); // unknown approval
  });
});
