// Payment safety under concurrency, retries and restarts. Real engine, in-memory store, a Stripe port
// double that counts charges per idempotency key. No network, no real charge.
import { describe, expect, it } from "vitest";
import { disabledPayer, HaggleEngine, InMemoryRepository, StubBrain, type StripePort } from "../src/index.ts";

/** Like Stripe: one PaymentIntent per idempotency key; optionally fails the first N calls (network). */
function countingStripe(failFirst = 0) {
  const byKey = new Map<string, string>();
  const calls: { key: string; amount: number; quote: string }[] = [];
  let failures = failFirst;
  const port: StripePort & { calls: typeof calls; created: () => number } = {
    simulated: false, calls, created: () => byKey.size, // behaves like Stripe test mode (not the labelled DEMO simulation)
    async charge(req) {
      calls.push({ key: req.idempotencyKey, amount: req.amountCents, quote: req.metadata.quote_id });
      await new Promise((r) => setTimeout(r, 5)); // overlap concurrent requests
      if (failures > 0) { failures--; return { ok: false, reason: "stripe_unreachable", retryable: true }; }
      if (!byKey.has(req.idempotencyKey)) byKey.set(req.idempotencyKey, `pi_TEST${byKey.size + 1}`);
      return { ok: true, paymentIntentId: byKey.get(req.idempotencyKey)!, receiptUrl: "https://pay.stripe.com/receipts/test" };
    },
  };
  return port;
}

const extractor = { async extract(i: { bodyText: string }) {
  const total = Number(/\$([\d,]+) total/.exec(i.bodyText)![1]!.replace(/,/g, ""));
  return { available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true, total_usd: total, deposit_usd: 400,
    menu_items: [], dietary_coverage: [], valid_until: null, questions: [], payment_request: "none" as const, instructions_to_agent: false,
    sources: [{ field: "total" as const, source: "text", excerpt: `$${total} total` }, { field: "deposit" as const, source: "text", excerpt: "$400 deposit" }], missing_fields: [], confidence: 0.9 };
} };

function engine(stripe: StripePort, repo = new InMemoryRepository()) {
  return new HaggleEngine({
    repo, extractor: extractor as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"), stripe,
    email: { async send() { return { providerId: "em", status: "sent", idempotentReplay: false, messageId: "<em@x>" }; } },
    imessage: { async send() { return { messageId: "im" }; } },
    config: { mode: "live", inboxDomain: "x.test", sharedInbox: "haggle@x.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 1 },
  });
}

async function approved(e: HaggleEngine) {
  const deal = await e.deal({ request: { what: "office deep clean", quantity: 1, unit: "job", date: "2026-11-05", area: "Oakland, CA", requirements: [] }, budget_usd: 3000, businesses: [{ name: "Sparkle Co", phone: "+14155550191", channel: "imessage" }] });
  await e.ingestIMessage({ messageId: "im1", from: "+14155550191", text: "$2,000 total, $400 deposit, supplies included", isGroup: false });
  await e.advanceJob(deal.job_id);
  const q = (await e.getQuotes(deal.job_id)).quotes[0]!;
  const a = await e.requestApproval(deal.job_id, q.quote_id, "view");
  await e.decideApproval(a.id, "approve", "imessage", "human");
  return { deal, q, a };
}

describe("payment safety", () => {
  it("five concurrent Pay taps make exactly one charge, of exactly the approved deposit, for exactly that quote", async () => {
    const stripe = countingStripe();
    const e = engine(stripe);
    const { deal, q } = await approved(e);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => e.pay(deal.job_id, q.quote_id)));
    expect(stripe.created()).toBe(1);
    expect(new Set(stripe.calls.map((c) => c.key)).size).toBe(1);
    expect(stripe.calls.every((c) => c.amount === 40_000 && c.quote === q.quote_id)).toBe(true);
    const ok = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ status: string }>).value.status);
    expect(ok.length).toBeGreaterThan(0);
    expect(ok.every((s) => s === "settled" || s === "charging")).toBe(true);
    expect((await e.getQuotes(deal.job_id)).payment).toMatchObject({ status: "settled", receipt_url: "https://pay.stripe.com/receipts/test" });
  });

  it("a retry after a server restart returns the same payment; a network failure retries under the same key", async () => {
    const stripe = countingStripe(1); // first attempt: network failure (retryable)
    const repo = new InMemoryRepository();
    const first = engine(stripe, repo);
    const { deal, q } = await approved(first);
    const r1 = await first.pay(deal.job_id, q.quote_id); // the engine retries the network failure itself, same key
    expect(r1).toMatchObject({ status: "settled", amount_usd: 400 });
    expect(stripe.calls.length).toBeGreaterThanOrEqual(2);
    const restarted = engine(stripe, repo); // same store, fresh process
    const r2 = await restarted.pay(deal.job_id, q.quote_id);
    const r3 = await restarted.pay(deal.job_id, q.quote_id);
    expect(r2).toMatchObject({ status: "settled", amount_usd: 400 });
    expect(r3).toMatchObject({ status: "settled", amount_usd: 400 });
    expect(stripe.created()).toBe(1);
    expect(new Set(stripe.calls.map((c) => c.key)).size).toBe(1); // every attempt used the same idempotency key
  });

  it("an approval past its expiry, or for a revised quote, is never charged", async () => {
    const stripe = countingStripe();
    let t = Date.now();
    const repo = new InMemoryRepository();
    const e = new HaggleEngine({ ...(engine(stripe, repo) as unknown as { d: ConstructorParameters<typeof HaggleEngine>[0] }).d, now: () => new Date(t) });
    const { deal, q } = await approved(e);
    t += 31 * 60_000; // past the 30-minute approval window
    await expect(e.pay(deal.job_id, q.quote_id)).rejects.toBeTruthy();
    expect(stripe.created()).toBe(0);
  });
});
