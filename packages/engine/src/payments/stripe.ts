// v5 payment rail: Stripe TEST MODE. The only place Stripe is called.
//
// Adapted from aarnav-old src/payments/stripe.ts + src/tools/pay.ts (quote-broker, worked in the
// Stripe sandbox): the amount is always the stored approval's payment_cents (never tool input),
// a pure guard runs before every charge, one payment per approval, a Stripe idempotency key per
// approval so retries can't double-charge, test keys only, and declines surface a code, never
// card details. Changes for Haggle: REST via fetch (fakeable, no SDK), a port so mock mode uses a
// labelled simulation, a payee check (the business that actually quoted, from a trusted sender),
// and retryable vs final failures (network/5xx keep the charge resumable under the same key).
import { checkApprovedPayment, type ApprovedPaymentInput, type ApprovedPaymentCode } from "./guard.ts";

export const STRIPE_NETWORK = "stripe-test";

export interface StripeChargeRequest {
  amountCents: number; // always the approval's payment_cents
  idempotencyKey: string;
  description: string;
  metadata: { job_id: string; approval_id: string; quote_id: string; business_id: string; business: string };
}

export type StripeChargeResult =
  | { ok: true; paymentIntentId: string; /** Stripe's hosted receipt (viewable without a Stripe login). */ receiptUrl?: string }
  | { ok: false; reason: string; retryable: boolean; paymentIntentId?: string };

export interface StripePort {
  /** True in mock mode: no Stripe call is made and every result is labelled DEMO. */
  readonly simulated: boolean;
  charge(req: StripeChargeRequest): Promise<StripeChargeResult>;
}

export interface StripeTestConfig {
  secretKey: string;
  customerId: string;
  paymentMethodId: string;
  fetchImpl?: typeof fetch;
}

/** Refuses anything but a test-mode secret key and well-formed customer / payment-method ids. */
export function validateStripeTestConfig(c: StripeTestConfig): string | null {
  if (!c.secretKey?.startsWith("sk_test_")) return "STRIPE_SECRET_KEY is not a test-mode key (must start with sk_test_)";
  if (!/^cus_[A-Za-z0-9]+$/.test(c.customerId ?? "")) return "STRIPE_CUSTOMER_ID must be a cus_… id";
  if (!/^pm_[A-Za-z0-9_]+$/.test(c.paymentMethodId ?? "")) return "STRIPE_PAYMENT_METHOD_ID must be a pm_… id";
  return null;
}

const API = "https://api.stripe.com/v1";

function form(o: Record<string, string | number | boolean>): string {
  return Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
}

/** Live Stripe test-mode charges against the operator's test customer + saved card. */
export function stripeTestPayments(c: StripeTestConfig): StripePort {
  const problem = validateStripeTestConfig(c);
  if (problem) throw new Error(problem);
  const f = c.fetchImpl ?? fetch;
  return {
    simulated: false,
    async charge(req) {
      if (!Number.isInteger(req.amountCents) || req.amountCents <= 0) return { ok: false, reason: "invalid_amount", retryable: false };
      const body = form({
        amount: req.amountCents, currency: "usd", customer: c.customerId, payment_method: c.paymentMethodId,
        confirm: true, off_session: true, description: req.description.slice(0, 300),
        "metadata[job_id]": req.metadata.job_id, "metadata[approval_id]": req.metadata.approval_id, "metadata[quote_id]": req.metadata.quote_id,
        "metadata[business_id]": req.metadata.business_id, "metadata[business]": req.metadata.business.slice(0, 100), "metadata[source]": "haggle",
      });
      let res: Response;
      try {
        res = await f(`${API}/payment_intents`, {
          method: "POST",
          headers: { authorization: `Bearer ${c.secretKey}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": req.idempotencyKey },
          body, signal: AbortSignal.timeout(20_000),
        });
      } catch {
        return { ok: false, reason: "stripe_unreachable", retryable: true };
      }
      const json = (await res.json().catch(() => ({}))) as { id?: string; status?: string; livemode?: boolean; error?: { code?: string; decline_code?: string; type?: string; payment_intent?: { id?: string } } };
      if (!res.ok) {
        const e = json.error ?? {};
        const pi = e.payment_intent?.id;
        // 429 / 5xx / idempotency-in-progress: try again later with the SAME key.
        if (res.status === 429 || res.status >= 500 || res.status === 409) return { ok: false, reason: e.code ?? `stripe_http_${res.status}`, retryable: true, ...(pi ? { paymentIntentId: pi } : {}) };
        // Card declines and request errors: final. Codes only; never card details.
        return { ok: false, reason: e.decline_code ?? e.code ?? e.type ?? `stripe_http_${res.status}`, retryable: false, ...(pi ? { paymentIntentId: pi } : {}) };
      }
      if (json.livemode !== false) return { ok: false, reason: "not_test_mode", retryable: false, ...(json.id ? { paymentIntentId: json.id } : {}) };
      if (json.status === "succeeded" && json.id) return verifyCharge(f, c, req, json.id);
      if (json.status === "processing") return { ok: false, reason: "processing", retryable: true, ...(json.id ? { paymentIntentId: json.id } : {}) };
      return { ok: false, reason: `payment_${json.status ?? "unknown"}`, retryable: false, ...(json.id ? { paymentIntentId: json.id } : {}) };
    },
  };
}

/**
 * A charge counts only after Stripe itself confirms it: read the PaymentIntent back (GET, separate
 * from the charge response) and check it is test mode, succeeded, for exactly the approved amount in
 * USD, on our customer, and tagged with this approval and quote. A mismatch is final (never paid);
 * an unreachable check is retryable (the same idempotency key replays the same PaymentIntent).
 */
async function verifyCharge(f: typeof fetch, c: StripeTestConfig, req: StripeChargeRequest, id: string): Promise<StripeChargeResult> {
  let pi: { id?: string; status?: string; livemode?: boolean; amount?: number; amount_received?: number; currency?: string; customer?: string | { id?: string }; metadata?: Record<string, string>; latest_charge?: string | { receipt_url?: string | null } | null };
  try {
    const res = await f(`${API}/payment_intents/${encodeURIComponent(id)}?expand[]=latest_charge`, { headers: { authorization: `Bearer ${c.secretKey}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { ok: false, reason: "verification_unavailable", retryable: true, paymentIntentId: id };
    pi = (await res.json()) as typeof pi;
  } catch {
    return { ok: false, reason: "verification_unavailable", retryable: true, paymentIntentId: id };
  }
  const customer = typeof pi.customer === "string" ? pi.customer : pi.customer?.id;
  const mismatch = pi.id !== id ? "id" : pi.livemode !== false ? "livemode" : pi.status !== "succeeded" ? "status"
    : pi.amount !== req.amountCents ? "amount" : pi.amount_received !== req.amountCents ? "amount_received" : pi.currency !== "usd" ? "currency"
    : customer !== c.customerId ? "customer" : pi.metadata?.approval_id !== req.metadata.approval_id || pi.metadata?.quote_id !== req.metadata.quote_id ? "metadata" : null;
  if (mismatch) return { ok: false, reason: `verification_failed:${mismatch}`, retryable: false, paymentIntentId: id };
  const receipt = typeof pi.latest_charge === "object" ? pi.latest_charge?.receipt_url : null;
  return { ok: true, paymentIntentId: id, ...(receipt && /^https:\/\/pay\.stripe\.com\//.test(receipt) ? { receiptUrl: receipt } : {}) };
}

/** Mock mode: no network; deterministic DEMO PaymentIntent ids; same idempotency semantics. */
export function simulatedStripe(opts: { decline?: string } = {}): StripePort & { charges: StripeChargeRequest[] } {
  const byKey = new Map<string, StripeChargeResult>();
  const charges: StripeChargeRequest[] = [];
  return {
    simulated: true,
    charges,
    async charge(req) {
      const prior = byKey.get(req.idempotencyKey);
      if (prior) return prior;
      charges.push(req);
      const r: StripeChargeResult = opts.decline
        ? { ok: false, reason: opts.decline, retryable: false }
        : { ok: true, paymentIntentId: `pi_DEMO${req.metadata.approval_id.replace(/[^A-Za-z0-9]/g, "").slice(-16)}` };
      byKey.set(req.idempotencyKey, r);
      return r;
    },
  };
}

/**
 * READ-ONLY sandbox check: the key is a test key, the customer exists, and the saved card is
 * attached to it. Creates nothing and charges nothing.
 */
export async function verifyStripeTestSetup(c: StripeTestConfig): Promise<{ ok: boolean; checks: { check: string; ok: boolean; detail?: string }[] }> {
  const checks: { check: string; ok: boolean; detail?: string }[] = [];
  const problem = validateStripeTestConfig(c);
  checks.push({ check: "test-mode key and id formats", ok: problem === null, ...(problem ? { detail: problem } : {}) });
  if (problem) return { ok: false, checks };
  const f = c.fetchImpl ?? fetch;
  const get = async (path: string) => {
    const r = await f(`${API}${path}`, { headers: { authorization: `Bearer ${c.secretKey}` }, signal: AbortSignal.timeout(15_000) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const cus = await get(`/customers/${encodeURIComponent(c.customerId)}`);
  checks.push({ check: "customer exists (test mode)", ok: cus.status === 200 && cus.json.livemode === false && !cus.json.deleted, ...(cus.status !== 200 ? { detail: `HTTP ${cus.status}` } : {}) });
  const pm = await get(`/payment_methods/${encodeURIComponent(c.paymentMethodId)}`);
  const card = pm.json.card as { brand?: string; last4?: string } | undefined;
  const attached = pm.status === 200 && pm.json.customer === c.customerId && pm.json.livemode === false;
  checks.push({
    check: "payment method attached to that customer", ok: attached,
    detail: pm.status !== 200 ? `HTTP ${pm.status}` : attached ? `${pm.json.type ?? "?"} ${card?.brand ?? ""} (test)`.trim()
      : pm.json.customer == null ? "not attached to any customer (a pm_card_* test token must be attached first: packages/engine/scripts/stripe-setup.ts --confirm)" : "attached to a different customer",
  });
  return { ok: checks.every((x) => x.ok), checks };
}

export type StripeGuardCode = ApprovedPaymentCode | "PAYEE_NOT_QUOTED" | "PAYMENT_DISABLED";

export interface StripeGuardInput extends ApprovedPaymentInput {
  /** The approved business as the engine knows it on this job. */
  payee: { business_id: string; on_job: boolean; quoted_from_trusted_sender: boolean } | null;
  stripeConfigured: boolean;
}

/**
 * PURE: may this Stripe charge run? Shared approval rules (exists, approved, unexpired, exact
 * quote/business/amount, cap, payable state, idempotent repeat) plus: the payee is the business
 * that actually quoted on this job, from an authenticated sender.
 */
export function checkStripePaymentAllowed(i: StripeGuardInput): { ok: true; existingPayment?: { id: string; status: string } } | { ok: false; code: StripeGuardCode; existingPayment?: { id: string; status: string } } {
  if (!i.stripeConfigured) return { ok: false, code: "PAYMENT_DISABLED" };
  const base = checkApprovedPayment(i, new Set(["charging"]));
  if (!base.ok || base.existingPayment) return base;
  if (!i.payee || !i.approval || i.payee.business_id !== i.approval.business_id || !i.payee.on_job || !i.payee.quoted_from_trusted_sender) return { ok: false, code: "PAYEE_NOT_QUOTED" };
  return { ok: true };
}
