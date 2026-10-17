// Per-user Stripe TEST customers (oauth mode). Each signed-in user gets their
// own test customer with Stripe's test Visa (pm_card_visa) attached, created on
// their first payment. Test mode only: stripeClient() refuses any other key.
import type { Caller } from "../caller.js";
import { ensureAppUser, updateAppUser } from "../db/queries.js";
import { stripeClient, type PaymentAccount } from "./stripe.js";

/**
 * The account to charge for this caller. Undefined in token mode, which means
 * "the operator's customer from the environment".
 */
export async function paymentAccountFor(caller: Caller): Promise<PaymentAccount | undefined> {
  if (!caller.userId) return undefined;
  try {
    return await createOrLoad(caller as Caller & { userId: string });
  } catch (err) {
    // Two first payments at once share the idempotency key; Stripe makes the
    // second wait ("idempotency key in use"). One short retry gets the result.
    if (!(err instanceof Error) || !/idempotent|idempotency/i.test(err.message)) throw err;
    await new Promise((r) => setTimeout(r, 1500));
    return createOrLoad(caller as Caller & { userId: string });
  }
}

async function createOrLoad(caller: Caller & { userId: string }): Promise<PaymentAccount> {
  const user = await ensureAppUser(caller.userId, caller.email ?? "");
  if (user.stripe_customer_id && user.stripe_payment_method_id) {
    return { customer: user.stripe_customer_id, paymentMethod: user.stripe_payment_method_id };
  }

  // Idempotency keys tie both calls to this user, so two concurrent first
  // payments get the same customer and card back instead of making two.
  const stripe = stripeClient();
  const customer =
    user.stripe_customer_id ??
    (
      await stripe.customers.create(
        { description: "Quote Broker demo user (test mode)", metadata: { app_user_id: caller.userId } },
        { idempotencyKey: `qb-customer:${caller.userId}` },
      )
    ).id;
  const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer }, { idempotencyKey: `qb-card:${caller.userId}` });
  await updateAppUser(caller.userId, { stripe_customer_id: customer, stripe_payment_method_id: pm.id });
  return { customer, paymentMethod: pm.id };
}
