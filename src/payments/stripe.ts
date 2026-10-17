// Charge an approved deposit with a Stripe PaymentIntent (DESIGN.md §14.3).
// Test mode only: config.ts refuses any key that isn't sk_test_.
import Stripe from "stripe";
import { ConfigError, getConfig } from "../config.js";

let client: Stripe | undefined;

/** Who gets charged: a Stripe test customer and the card saved on it. */
export interface PaymentAccount {
  customer: string;
  paymentMethod: string;
}

/** The Stripe client, test mode only. */
export function stripeClient(): Stripe {
  const key = getConfig().STRIPE_SECRET_KEY;
  if (!key) throw new ConfigError(["STRIPE_SECRET_KEY"]);
  if (!key.startsWith("sk_test_")) throw new Error("Stripe key is not a test-mode key");
  return (client ??= new Stripe(key));
}

/** Token mode: the operator's one test customer from the environment. */
function operatorAccount(): PaymentAccount {
  const cfg = getConfig();
  const missing = (["STRIPE_CUSTOMER_ID", "STRIPE_PAYMENT_METHOD_ID"] as const).filter((k) => !cfg[k]);
  if (missing.length > 0) throw new ConfigError([...missing]);
  return { customer: cfg.STRIPE_CUSTOMER_ID!, paymentMethod: cfg.STRIPE_PAYMENT_METHOD_ID! };
}

export type ChargeResult =
  | { ok: true; paymentIntentId: string }
  | { ok: false; reason: string; paymentIntentId?: string };

/**
 * Charge exactly `amountCents` (always approval.amount_cents from the database).
 * The idempotency key makes a retried call return the original PaymentIntent
 * instead of charging twice.
 */
export async function chargeDeposit(opts: {
  amountCents: number;
  idempotencyKey: string;
  metadata: { job_id: string; approval_id: string; vendor_id: string };
  description: string;
  /** Per-user test customer (oauth mode); defaults to the operator's. */
  account?: PaymentAccount;
}): Promise<ChargeResult> {
  const stripe = stripeClient();
  const account = opts.account ?? operatorAccount();
  try {
    const intent = await stripe.paymentIntents.create(
      {
        amount: opts.amountCents,
        currency: "usd",
        customer: account.customer,
        payment_method: account.paymentMethod,
        confirm: true,
        off_session: true,
        description: opts.description,
        metadata: opts.metadata,
      },
      { idempotencyKey: opts.idempotencyKey },
    );
    if (intent.status === "succeeded") return { ok: true, paymentIntentId: intent.id };
    return { ok: false, reason: `payment status ${intent.status}`, paymentIntentId: intent.id };
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) {
      // Card declines and similar; never log or return card details.
      return { ok: false, reason: err.code ?? err.type };
    }
    throw err;
  }
}
