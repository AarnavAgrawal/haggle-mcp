// One-time Stripe TEST-MODE setup (adapted from aarnav-old scripts/setupStripe.ts): attach Stripe's
// test card token (pm_card_visa) to the operator's test customer and make it the default, so
// off-session deposit charges can use it. Creates NO charge. Refuses non-test keys.
//
//   node packages/engine/scripts/stripe-setup.ts <path to .env>            # dry run: read-only check
//   node packages/engine/scripts/stripe-setup.ts <path to .env> --confirm  # attach + write the pm_ id
//
// Idempotent: the attach uses a fixed idempotency key per customer, and an already-attached card is
// reused. Prints no secrets.
import { readFileSync, writeFileSync } from "node:fs";
import { verifyStripeTestSetup } from "../src/payments/stripe.ts";

const [envPath, flag] = process.argv.slice(2);
if (!envPath) throw new Error("usage: stripe-setup.ts <path to .env> [--confirm]");
const text = readFileSync(envPath, "utf8");
const env: Record<string, string> = {};
for (const l of text.split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]!] = m[2]!.trim(); }
const key = env.STRIPE_SECRET_KEY ?? "";
const customer = env.STRIPE_CUSTOMER_ID ?? "";
if (!key.startsWith("sk_test_")) throw new Error("STRIPE_SECRET_KEY must be a TEST key (sk_test_...). Live keys are refused.");
if (!/^cus_/.test(customer)) throw new Error("STRIPE_CUSTOMER_ID must be a cus_... test customer.");

const before = await verifyStripeTestSetup({ secretKey: key, customerId: customer, paymentMethodId: env.STRIPE_PAYMENT_METHOD_ID ?? "" });
for (const c of before.checks) console.log(`[${c.ok ? "PASS" : "FAIL"}] ${c.check}${c.detail ? ` — ${c.detail}` : ""}`);
if (before.ok) { console.log("Already set up; nothing to do."); process.exit(0); }
if (flag !== "--confirm") { console.log("Dry run: nothing changed. Re-run with --confirm to attach pm_card_visa to the customer (no charge)."); process.exit(0); }

const auth = { authorization: `Bearer ${key}` };
const post = async (path: string, body: Record<string, string>, idem?: string) => {
  const r = await fetch(`https://api.stripe.com/v1${path}`, { method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded", ...(idem ? { "idempotency-key": idem } : {}) }, body: new URLSearchParams(body).toString() });
  const j = (await r.json()) as { id?: string; livemode?: boolean; error?: { code?: string; message?: string } };
  if (!r.ok) throw new Error(`Stripe ${path}: ${j.error?.code ?? r.status}`);
  if (j.livemode !== false) throw new Error("Stripe answered in live mode; stopping.");
  return j;
};
const pm = await post("/payment_methods/pm_card_visa/attach", { customer }, `haggle-setup-card-${customer}`);
await post(`/customers/${customer}`, { "invoice_settings[default_payment_method]": pm.id! });
writeFileSync(envPath, /^STRIPE_PAYMENT_METHOD_ID=.*$/m.test(text) ? text.replace(/^STRIPE_PAYMENT_METHOD_ID=.*$/m, `STRIPE_PAYMENT_METHOD_ID=${pm.id}`) : `${text.trimEnd()}\nSTRIPE_PAYMENT_METHOD_ID=${pm.id}\n`);
const after = await verifyStripeTestSetup({ secretKey: key, customerId: customer, paymentMethodId: pm.id! });
console.log(`Attached a test Visa (${pm.id!.slice(0, 7)}…) to the customer and saved STRIPE_PAYMENT_METHOD_ID. Setup ${after.ok ? "verified" : "NOT verified"}. No charge was made.`);
