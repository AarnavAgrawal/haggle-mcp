// LIVE MODE wiring (HAGGLE_MODE=live), v5: Postgres persistence, the Inkbox buyer identity for
// email (+ attachments), Claude extraction, and the real brain (@haggle/brain via the engine's
// adapter; profiles in Supabase when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set). Voice AI calls stay OFF unless HAGGLE_ENABLE_CALLS=true (separate
// human approval; only simulated businesses or people who agreed). Payments: Stripe TEST MODE only
// when HAGGLE_ENABLE_PAYMENTS=true and the key is sk_test_ (refuses to start otherwise); without the
// flag every payment is refused (disabledPayer), never faked. No Primitive/x402 keys.
import {
  businessIdFor, claudeExtractor, connectInkboxBuyer, disabledPayer, heuristicExtractor, stripeTestPayments, type InkboxTrustPolicy, HaggleEngine, inkboxAttachments, inkboxEmail, parseFleet, PostgresRepository, slugify,
  withHeuristicFallback,
} from "@haggle/engine";
import { makeBrain } from "./brain.ts";
import { registerLiveFactory, type Runtime } from "./runtime.ts";

const TICK_MS = 30_000;

registerLiveFactory(async (env): Promise<Runtime> => {
  const { api, buyerMailbox, phone, a2a, imessage, voice, identityInfo, transcript, callOrigin } = await connectInkboxBuyer({ apiKey: env.INKBOX_API_KEY!, handle: env.INKBOX_IDENTITY?.trim() || "haggle" });

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
  const allowlist = [...fleet.map((b) => b.email), ...(env.HAGGLE_ALLOWED_RECIPIENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
  // Seller-reply trust (see InkboxTrustPolicy): strict by default; "pinned-org-identity" is the
  // operator opt-in for an agent-scoped buyer key, limited to the pinned fleet/allowlist addresses.
  const senderTrust: InkboxTrustPolicy = env.INKBOX_SENDER_TRUST === "pinned-org-identity"
    ? { policy: "pinned-org-identity", allowedSenders: allowlist.filter((a) => a.includes("@") && !a.startsWith("@")) }
    : { policy: "outbound-verified" };
  const brain = makeBrain(fleet.map((b) => ({ business_id: b.business_id, name: b.name, email: b.email, simulated: b.simulated })), env);
  const log = (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ level: "info", event, ...data }));
  // Claude reads replies; if it fails (or there's no key) the keyword fallback reads them at low
  // confidence, so a reply is never silently dropped (its quote is flagged low_confidence).
  const extractor = env.ANTHROPIC_API_KEY?.trim()
    ? withHeuristicFallback(claudeExtractor({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5", ...(env.ANTHROPIC_WORKSPACE_ID ? { workspaceId: env.ANTHROPIC_WORKSPACE_ID } : {}) }), log)
    : heuristicExtractor;
  if (!env.ANTHROPIC_API_KEY?.trim()) console.error(JSON.stringify({ level: "warn", event: "no_anthropic_key", detail: "replies are read by the keyword fallback (low confidence)" }));
  // Call hours (local, in each workspace's timezone) and email -> call escalation timing.
  const hours = (env.HAGGLE_CALL_HOURS ?? "9-20").match(/^(\d{1,2})-(\d{1,2})$/);
  const callHours = hours && Number(hours[1]) < Number(hours[2]) && Number(hours[2]) <= 24 ? { start: Number(hours[1]), end: Number(hours[2]) } : { start: 9, end: 20 };
  const escalationMin = Number(env.HAGGLE_ESCALATION_WAIT_MINUTES ?? "15");
  const engine = new HaggleEngine({
    repo,
    email: inkboxEmail(api, buyerMailbox),
    ...(phonePort ? { phone: phonePort } : {}),
    ...(a2aPort ? { a2a: a2aPort } : {}),
    ...(imessagePort ? { imessage: imessagePort } : {}),
    // Inbound callbacks: keep the Voice AI's answering instructions in sync with open requests (calls on only).
    ...(phonePort && env.HAGGLE_SYNC_VOICE_CONTEXT !== "false" ? { voice: voice() } : {}),
    extractor,
    attachments: inkboxAttachments(api, buyerMailbox),
    brain,
    payer: disabledPayer("Payments are not enabled on this server (HAGGLE_ENABLE_PAYMENTS is off); nothing was charged."),
    ...(stripe ? { stripe } : {}),
    config: {
      mode: "live", inboxDomain: buyerMailbox.split("@")[1]!, sharedInbox: buyerMailbox, collectionWindowMs: 30 * 60_000, negotiationWindowMs: 15 * 60_000,
      approvalTtlMs: 30 * 60_000, globalPaymentCapCents: Number.isInteger(cap) && cap > 0 && cap <= capMax ? cap : stripe ? 50_000 : 500, maxRounds: 2,
      defaultSpendingCapCents: 150_000, spendingCapCeilingCents: Number.isInteger(ceiling) && ceiling > 0 ? ceiling : 500_000,
      ...(allowAny ? {} : { recipientAllowlist: allowlist }),
      trustInboundCallerId: env.HAGGLE_TRUST_INBOUND_CALLER_ID === "true",
      callHours, callCooldownMs: 2 * 60_000, escalationWaitMs: (Number.isFinite(escalationMin) && escalationMin > 0 ? escalationMin : 15) * 60_000,
      identity: { name: identityInfo.displayName || "Haggle", phone: identityInfo.phoneNumber },
    },
    log,
  });
  // Backup tick: deadlines advance even when no agent is calling.
  setInterval(() => {
    void repo.listOpenJobs().then((jobs) => Promise.all(jobs.map((j) => engine.advanceJob(j.id)))).catch((e) => console.error(JSON.stringify({ level: "error", event: "tick_failed", error: (e as Error).message })));
  }, TICK_MS).unref();
  console.log(JSON.stringify({ level: "info", event: "live_ready", buyer: buyerMailbox, calls: callsEnabled, call_origin: callsEnabled ? callOrigin : null, a2a: a2aPort !== null, imessage: imessagePort !== null, payments: stripe ? "stripe-test" : "disabled", allowed_recipients: allowAny ? "any" : allowlist.length, sender_trust: senderTrust.policy }));
  return { mode: "live", engine, brain, missing: [], inkbox: { api, buyerMailbox, webhookSecret: env.INKBOX_WEBHOOK_SECRET!, senderTrust, transcript } };
});
