// One-time Stripe test-mode setup (DESIGN.md §14.1): a test customer with the
// test card pm_card_visa attached, saved as the default payment method.
// Writes STRIPE_CUSTOMER_ID and STRIPE_PAYMENT_METHOD_ID into .env.
//
// Run: npm run setup:stripe   (needs STRIPE_SECRET_KEY=sk_test_... in .env)
import Stripe from "stripe";
import { setEnvVars } from "./envFile.ts";

const key = process.env.STRIPE_SECRET_KEY;
if (!key?.startsWith("sk_test_")) {
  console.error("Set STRIPE_SECRET_KEY to a TEST key (sk_test_...) in .env first. Live keys are refused.");
  process.exit(1);
}

const stripe = new Stripe(key);
const customer = await stripe.customers.create({
  name: "Quote Broker demo buyer",
  description: "Test-mode customer for Quote Broker deposits",
});
const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });

setEnvVars({ STRIPE_CUSTOMER_ID: customer.id, STRIPE_PAYMENT_METHOD_ID: pm.id });
console.log(`Created test customer ${customer.id} with card ${pm.id}; saved both to .env.`);
console.log("Add the same two values to the Manufact Cloud environment variables.");
