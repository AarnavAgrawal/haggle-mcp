// LIVE MODE wiring (HAGGLE_MODE=live), v5: Postgres persistence, the Inkbox buyer identity for
// email (+ attachments), Claude extraction, and the real brain (@haggle/brain via the engine's
// adapter; profiles in Supabase when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set). Voice AI calls stay OFF unless HAGGLE_ENABLE_CALLS=true (separate
// human approval; only simulated businesses or people who agreed). A2A tasks and iMessage (approvals and
// texting businesses that connected first) are also opt-in. Payments: Stripe TEST MODE only
// when HAGGLE_ENABLE_PAYMENTS=true and the key is sk_test_ (refuses to start otherwise); without the
// flag every payment is refused (disabledPayer), never faked. No Primitive/x402 keys.
import {
  businessIdFor, claudeExtractor, placesReputation, connectInkboxBuyer, disabledPayer, stripeTestPayments, type InkboxTrustPolicy, HaggleEngine, inkboxAttachments, inkboxEmail, parseFleet, PostgresRepository, slugify,
} from "@haggle/engine";
import { makeBrain } from "./brain.ts";
import { registerLiveFactory, type Runtime } from "./runtime.ts";
import { buildRoster, parseVendorConfig, rosterRecipients, type VendorContact } from "./vendors.ts";

const TICK_MS = 30_000;

registerLiveFactory(async (env): Promise<Runtime> => {
  const { api, buyerMailbox, phone, a2a, imessage, transcript, callOrigin, connectedNumbers, connectCommand } = await connectInkboxBuyer({ apiKey: env.INKBOX_API_KEY!, handle: env.INKBOX_IDENTITY?.trim() || "haggle" });

  // Only the explicitly configured simulated fleet is offered by discover (never arbitrary businesses).
  const fleet = parseFleet(env.HAGGLE_DEMO_FLEET).map((b) => ({
    business_id: businessIdFor(b.email), slug: slugify(b.name), name: b.name, email: b.email, source: "fleet" as const, simulated: true, found_at: "HAGGLE_DEMO_FLEET",
  }));
  // Stripe test mode is opt-in; a non-test key or a missing customer/card refuses to start (throws).
  const paymentsOn = env.HAGGLE_ENABLE_PAYMENTS === "true";
  const stripe = paymentsOn ? stripeTestPayments({ secretKey: env.STRIPE_SECRET_KEY ?? "", customerId: env.STRIPE_CUSTOMER_ID ?? "", paymentMethodId: env.STRIPE_PAYMENT_METHOD_ID ?? "" }) : undefined;
  // Per-payment ceiling (operator): one value whether or not payments are on (live has no x402 rail).
  // Default $5,000, max $10,000. Separate from each deal's budget and the human's settings cap.
  const cap = Number(env.HAGGLE_GLOBAL_PAYMENT_CAP_CENTS ?? "500000");
  const capMax = 1_000_000;
  const ceiling = Number(env.HAGGLE_SPENDING_CAP_CEILING_CENTS ?? "500000");
  const repo = new PostgresRepository(env.SUPABASE_DB_URL!, env.HAGGLE_DB_SCHEMA?.trim() ? { schema: env.HAGGLE_DB_SCHEMA.trim() } : {});
  // Each outbound channel is OFF unless explicitly enabled (real calls / iMessages / A2A tasks need
  // Yash's go-ahead). A2A cards and phone numbers must still be on the recipient allowlist; iMessage
  // only ever goes to the settings approver.
  const phonePort = env.HAGGLE_ENABLE_CALLS === "true" ? phone() : null;
  const callsEnabled = phonePort !== null;
  if (env.HAGGLE_ENABLE_CALLS === "true" && !phonePort) console.error(JSON.stringify({ level: "warn", event: "calls_unavailable", reason: "the buyer identity has no phone number and iMessage is off" }));
  const a2aPort = env.HAGGLE_ENABLE_A2A === "true" ? a2a() : null;
  const imessagePort = env.HAGGLE_ENABLE_IMESSAGE === "true" ? imessage() : null;
  // Never contact arbitrary businesses: only the simulated fleet and explicitly allowed recipients.
  const allowAny = env.HAGGLE_ALLOW_ANY_RECIPIENT === "true";
  // The demo vendor roster: configuring a vendor's contact is the operator authorizing it as a recipient.
  const vendorConfig = parseVendorConfig(env.HAGGLE_DEMO_VENDORS);
  const contacts: Record<string, VendorContact> = { ...vendorConfig.contacts };
  // The roster is exactly HAGGLE_DEMO_VENDORS. Legacy HAGGLE_DEMO_FLEET addresses stay on the recipient
  // allowlist (for businesses named explicitly) but are never contacted by default.
  const allowlist = [...new Set([...fleet.map((b) => b.email), ...rosterRecipients(vendorConfig.contacts), ...(env.HAGGLE_ALLOWED_RECIPIENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean)])];
  // Seller-reply trust (see InkboxTrustPolicy): strict by default; "pinned-org-identity" is the
  // operator opt-in for an agent-scoped buyer key, limited to the pinned fleet/allowlist addresses.
  const senderTrust: InkboxTrustPolicy = env.INKBOX_SENDER_TRUST === "pinned-org-identity"
    ? { policy: "pinned-org-identity", allowedSenders: allowlist.filter((a) => a.includes("@") && !a.startsWith("@")) }
    : { policy: "outbound-verified" };
  const brain = makeBrain(fleet.map((b) => ({ business_id: b.business_id, name: b.name, email: b.email, simulated: b.simulated })), env);
  const engine = new HaggleEngine({
    repo,
    email: inkboxEmail(api, buyerMailbox),
    ...(phonePort ? { phone: phonePort } : {}),
    ...(a2aPort ? { a2a: a2aPort } : {}),
    ...(imessagePort ? { imessage: imessagePort } : {}),
    extractor: claudeExtractor({ apiKey: env.ANTHROPIC_API_KEY!, model: env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5", ...(env.ANTHROPIC_WORKSPACE_ID ? { workspaceId: env.ANTHROPIC_WORKSPACE_ID } : {}) }),
    attachments: inkboxAttachments(api, buyerMailbox),
    brain,
    payer: disabledPayer("Payments are not enabled on this server (HAGGLE_ENABLE_PAYMENTS is off); nothing was charged."),
    ...(stripe ? { stripe } : {}),
    // Public reviews for real businesses (Google Places), only when a key is configured; never for demo vendors.
    reputation: placesReputation({ ...(env.GOOGLE_PLACES_API_KEY ? { apiKey: env.GOOGLE_PLACES_API_KEY } : {}), log: (event, data) => console.log(JSON.stringify({ level: "info", event, ...data })) }),
    config: {
      mode: "live", inboxDomain: buyerMailbox.split("@")[1]!, sharedInbox: buyerMailbox, collectionWindowMs: 30 * 60_000, negotiationWindowMs: 15 * 60_000,
      approvalTtlMs: 30 * 60_000, globalPaymentCapCents: Number.isInteger(cap) && cap > 0 && cap <= capMax ? cap : 500_000, maxRounds: 2,
      defaultSpendingCapCents: 150_000, spendingCapCeilingCents: Number.isInteger(ceiling) && ceiling > 0 ? ceiling : 500_000,
      ...(allowAny ? {} : { recipientAllowlist: allowlist }),
      trustInboundCallerId: env.HAGGLE_TRUST_INBOUND_CALLER_ID === "true",
      ...(Number(env.HAGGLE_CALL_DELAY_S) > 0 ? { callDelayMs: Number(env.HAGGLE_CALL_DELAY_S) * 1000 } : {}),
      ...(Number(env.HAGGLE_ESCALATE_EMAIL_TO_CALL_S) > 0 ? { escalateEmailToCallAfterMs: Number(env.HAGGLE_ESCALATE_EMAIL_TO_CALL_S) * 1000 } : {}),
    },
    log: (event, data) => console.log(JSON.stringify({ level: "info", event, ...data })),
  });
  // Backup tick: deadlines advance even when no agent is calling.
  setInterval(() => {
    void repo.listOpenJobs().then((jobs) => Promise.all(jobs.map((j) => engine.advanceJob(j.id)))).catch((e) => console.error(JSON.stringify({ level: "error", event: "tick_failed", error: (e as Error).message })));
  }, TICK_MS).unref();
  console.log(JSON.stringify({ level: "info", event: "live_ready", buyer: buyerMailbox, calls: callsEnabled, call_origin: callsEnabled ? callOrigin : null, a2a: a2aPort !== null, imessage: imessagePort !== null, payments: stripe ? "stripe-test" : "disabled", payment_ceiling_cents: Number.isInteger(cap) && cap > 0 && cap <= capMax ? cap : 500_000, reputation: env.GOOGLE_PLACES_API_KEY ? "google-places" : "off", allowed_recipients: allowAny ? "any" : allowlist.length, sender_trust: senderTrust.policy }));
  // Readiness is re-checked at most every 20 s (one read-only Inkbox call); a failed check is "unknown", not "ready".
  let connected: { at: number; set: Set<string> | null } = { at: 0, set: null };
  const roster = async () => {
    if (imessagePort || phonePort) {
      if (Date.now() - connected.at > 20_000) connected = { at: Date.now(), set: await connectedNumbers().catch(() => null) };
    }
    return buildRoster(contacts, { email: true, imessage: imessagePort !== null, phone: phonePort !== null, a2a: a2aPort !== null, connectCommand, connected: connected.set, callsViaSharedLine: callOrigin === "shared_imessage_number" });
  };
  if (vendorConfig.errors.length) console.error(JSON.stringify({ level: "warn", event: "demo_vendors_config", errors: vendorConfig.errors }));
  return { mode: "live", engine, brain, missing: [], roster, configErrors: vendorConfig.errors, inkbox: { api, buyerMailbox, webhookSecret: env.INKBOX_WEBHOOK_SECRET!, senderTrust, transcript } };
});
