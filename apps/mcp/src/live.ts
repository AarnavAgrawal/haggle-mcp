// LIVE MODE wiring (HAGGLE_MODE=live), v5: Postgres persistence, the Inkbox buyer identity for
// email (+ attachments), Claude extraction, and the brain (engine stand-in until Partner's
// @haggle/brain is published). Voice AI calls stay OFF unless HAGGLE_ENABLE_CALLS=true (separate
// human approval; only simulated businesses or people who agreed). Payments: Stripe TEST MODE only
// when HAGGLE_ENABLE_PAYMENTS=true and the key is sk_test_ (refuses to start otherwise); without the
// flag every payment is refused (disabledPayer), never faked. No Primitive/x402 keys.
import {
  businessIdFor, claudeExtractor, connectInkboxBuyer, disabledPayer, stripeTestPayments, type InkboxTrustPolicy, HaggleEngine, inkboxAttachments, inkboxEmail, parseFleet, PostgresRepository, StubBrain, slugify,
} from "@haggle/engine";
import { registerLiveFactory, type Runtime } from "./runtime.ts";

const TICK_MS = 30_000;

registerLiveFactory(async (env): Promise<Runtime> => {
  const { api, buyerMailbox, phone } = await connectInkboxBuyer({ apiKey: env.INKBOX_API_KEY!, handle: env.INKBOX_IDENTITY?.trim() || "haggle" });

  // Only the explicitly configured simulated fleet is offered by discover (never arbitrary businesses).
  const fleet = parseFleet(env.HAGGLE_DEMO_FLEET).map((b) => ({
    business_id: businessIdFor(b.email), slug: slugify(b.name), name: b.name, email: b.email, source: "fleet" as const, simulated: true, found_at: "HAGGLE_DEMO_FLEET",
  }));
  // Stripe test mode is opt-in; a non-test key or a missing customer/card refuses to start (throws).
  const paymentsOn = env.HAGGLE_ENABLE_PAYMENTS === "true";
  const stripe = paymentsOn ? stripeTestPayments({ secretKey: env.STRIPE_SECRET_KEY ?? "", customerId: env.STRIPE_CUSTOMER_ID ?? "", paymentMethodId: env.STRIPE_PAYMENT_METHOD_ID ?? "" }) : undefined;
  // Per-payment ceiling (operator): x402 keeps its $10 testnet limit; Stripe defaults to $500, max $10,000.
  const cap = Number(env.HAGGLE_GLOBAL_PAYMENT_CAP_CENTS ?? (stripe ? "50000" : "500"));
  const capMax = stripe ? 1_000_000 : 1000;
  const ceiling = Number(env.HAGGLE_SPENDING_CAP_CEILING_CENTS ?? "500000");
  const repo = new PostgresRepository(env.SUPABASE_DB_URL!);
  const callsEnabled = env.HAGGLE_ENABLE_CALLS === "true";
  // Never contact arbitrary businesses: only the simulated fleet and explicitly allowed recipients.
  const allowAny = env.HAGGLE_ALLOW_ANY_RECIPIENT === "true";
  const allowlist = [...fleet.map((b) => b.email), ...(env.HAGGLE_ALLOWED_RECIPIENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
  // Seller-reply trust (see InkboxTrustPolicy): strict by default; "pinned-org-identity" is the
  // operator opt-in for an agent-scoped buyer key, limited to the pinned fleet/allowlist addresses.
  const senderTrust: InkboxTrustPolicy = env.INKBOX_SENDER_TRUST === "pinned-org-identity"
    ? { policy: "pinned-org-identity", allowedSenders: allowlist.filter((a) => a.includes("@") && !a.startsWith("@")) }
    : { policy: "outbound-verified" };
  const engine = new HaggleEngine({
    repo,
    email: inkboxEmail(api, buyerMailbox),
    ...(callsEnabled ? { phone: phone() } : {}),
    extractor: claudeExtractor({ apiKey: env.ANTHROPIC_API_KEY!, model: env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5", ...(env.ANTHROPIC_WORKSPACE_ID ? { workspaceId: env.ANTHROPIC_WORKSPACE_ID } : {}) }),
    attachments: inkboxAttachments(api, buyerMailbox),
    brain: new StubBrain(fleet),
    payer: disabledPayer("Payments are not enabled on this server (HAGGLE_ENABLE_PAYMENTS is off); nothing was charged."),
    ...(stripe ? { stripe } : {}),
    config: {
      mode: "live", inboxDomain: buyerMailbox.split("@")[1]!, sharedInbox: buyerMailbox, collectionWindowMs: 30 * 60_000, negotiationWindowMs: 15 * 60_000,
      approvalTtlMs: 30 * 60_000, globalPaymentCapCents: Number.isInteger(cap) && cap > 0 && cap <= capMax ? cap : stripe ? 50_000 : 500, maxRounds: 2,
      defaultSpendingCapCents: 150_000, spendingCapCeilingCents: Number.isInteger(ceiling) && ceiling > 0 ? ceiling : 500_000,
      ...(allowAny ? {} : { recipientAllowlist: allowlist }),
    },
    log: (event, data) => console.log(JSON.stringify({ level: "info", event, ...data })),
  });
  // Backup tick: deadlines advance even when no agent is calling.
  setInterval(() => {
    void repo.listOpenJobs().then((jobs) => Promise.all(jobs.map((j) => engine.advanceJob(j.id)))).catch((e) => console.error(JSON.stringify({ level: "error", event: "tick_failed", error: (e as Error).message })));
  }, TICK_MS).unref();
  console.log(JSON.stringify({ level: "info", event: "live_ready", buyer: buyerMailbox, calls: callsEnabled, payments: stripe ? "stripe-test" : "disabled", allowed_recipients: allowAny ? "any" : allowlist.length, sender_trust: senderTrust.policy }));
  return { mode: "live", engine, missing: [], inkbox: { api, buyerMailbox, webhookSecret: env.INKBOX_WEBHOOK_SECRET!, senderTrust } };
});
