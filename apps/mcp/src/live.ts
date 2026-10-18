// LIVE MODE wiring (HAGGLE_MODE=live), v5: Postgres persistence, the Inkbox buyer identity for
// email (+ attachments), Claude extraction, and the real brain (@haggle/brain via the engine's
// adapter; profiles in Supabase when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set). Voice AI calls stay OFF unless HAGGLE_ENABLE_CALLS=true (separate
// human approval; only simulated businesses or people who agreed). A2A tasks and iMessage (approvals and
// texting businesses that connected first) are also opt-in. Payments: Stripe TEST MODE only
// when HAGGLE_ENABLE_PAYMENTS=true and the key is sk_test_ (refuses to start otherwise); without the
// flag every payment is refused (disabledPayer), never faked. No Primitive/x402 keys.
import {
  businessIdForContact, MAX_ROUNDS, claudeExtractor, claudeStrategist, createAnthropicClient, placesReputation, connectInkboxBuyer, disabledPayer, InboundReconciler, stripeTestPayments, type InkboxTrustPolicy, HaggleEngine, inkboxAttachments, inkboxEmail, parseFleet, PostgresRepository, slugify,
  withHeuristicFallback,
} from "@haggle/engine";
import { makeBrain } from "./brain.ts";
import { registerLiveFactory, type Runtime } from "./runtime.ts";
import { buildRoster, DEMO_VENDORS, parseVendorConfig, rosterRecipients, type ChannelStatus, type VendorContact } from "./vendors.ts";

const TICK_MS = 30_000;

registerLiveFactory(async (env): Promise<Runtime> => {
  const { api, buyerMailbox, phone, a2a, imessage, sms, voice, identityInfo, transcript, callOrigin, connectedNumbers, connectCommand, identityAddresses, listTexts, listCalls } = await connectInkboxBuyer({ apiKey: env.INKBOX_API_KEY!, handle: env.INKBOX_IDENTITY?.trim() || "haggle" });

  // Only the explicitly configured simulated fleet is offered by discover (never arbitrary businesses).
  const fleet = parseFleet(env.HAGGLE_DEMO_FLEET).map((b) => ({
    business_id: businessIdForContact({ email: b.email }, b.name), slug: slugify(b.name), name: b.name, email: b.email, source: "fleet" as const, simulated: true, found_at: "HAGGLE_DEMO_FLEET",
  }));
  // Stripe test mode is opt-in; a non-test key or a missing customer/card refuses to start (throws).
  const paymentsOn = env.HAGGLE_ENABLE_PAYMENTS === "true";
  const stripe = paymentsOn ? stripeTestPayments({ secretKey: env.STRIPE_SECRET_KEY ?? "", customerId: env.STRIPE_CUSTOMER_ID ?? "", paymentMethodId: env.STRIPE_PAYMENT_METHOD_ID ?? "" }) : undefined;
  // Per-payment ceiling (operator): one value whether or not payments are on (live has no x402 rail).
  // Default $5,000, max $10,000. Separate from each deal's budget and the human's settings cap.
  const cap = Number(env.HAGGLE_GLOBAL_PAYMENT_CAP_CENTS ?? "500000");
  const capMax = 1_000_000;
  const ceiling = Number(env.HAGGLE_SPENDING_CAP_CEILING_CENTS ?? "500000");
  // Supabase's session pooler caps clients (15): a small pool per process (HAGGLE_DB_POOL_MAX, default 4).
  const poolMax = Number(env.HAGGLE_DB_POOL_MAX ?? "4");
  const repo = new PostgresRepository(env.SUPABASE_DB_URL!, { max: Number.isInteger(poolMax) && poolMax >= 1 && poolMax <= 10 ? poolMax : 4, ...(env.HAGGLE_DB_SCHEMA?.trim() ? { schema: env.HAGGLE_DB_SCHEMA.trim() } : {}) });
  // Each outbound channel is OFF unless explicitly enabled (real calls / iMessages / A2A tasks need
  // Yash's go-ahead). A2A cards and phone numbers must still be on the recipient allowlist; iMessage
  // only ever goes to the settings approver.
  const phonePort = env.HAGGLE_ENABLE_CALLS === "true" ? phone() : null;
  const callsEnabled = phonePort !== null;
  if (env.HAGGLE_ENABLE_CALLS === "true" && !phonePort) console.error(JSON.stringify({ level: "warn", event: "calls_unavailable", reason: "the buyer identity has no phone number and iMessage is off" }));
  const a2aPort = env.HAGGLE_ENABLE_A2A === "true" ? a2a() : null;
  const imessagePort = env.HAGGLE_ENABLE_IMESSAGE === "true" ? imessage() : null;
  // SMS from the buyer's own number: update texts to HAGGLE_NOTIFY_PHONE (else the settings approver)
  // and one follow-up text to an allowlisted phone business whose call left the total unclear.
  const smsPort = env.HAGGLE_ENABLE_SMS === "true" ? sms() : null;
  if (env.HAGGLE_ENABLE_SMS === "true" && !smsPort) console.error(JSON.stringify({ level: "warn", event: "sms_unavailable", reason: "the buyer identity has no SMS-ready phone number" }));
  const notifyPhone = env.HAGGLE_NOTIFY_PHONE?.replace(/[\s().-]/g, "");
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
  // Every configured vendor's identity (name + contact) is known to the brain, so its memory, including
  // quotes learned under an older contact-only id, is found by the same id deal uses.
  const vendorIdentities = Object.entries(vendorConfig.contacts).flatMap(([key, c]) => {
    const name = c.name ?? DEMO_VENDORS.find((v) => v.key === key)?.name;
    return name && (c.email || c.phone) ? [{ business_id: businessIdForContact({ email: c.email ?? null, phone: c.phone ?? null, a2a_card_url: c.a2a_card_url ?? null }, name), name, ...(c.email ? { email: c.email } : {}), ...(c.phone ? { phone: c.phone } : {}), simulated: true }] : [];
  });
  const brain = makeBrain([...fleet.map((b) => ({ business_id: b.business_id, name: b.name, email: b.email, simulated: b.simulated })), ...vendorIdentities], env, { observed: true });
  const log = (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ level: "info", event, ...data }));
  // Claude reads replies (ANTHROPIC_API_KEY is required in live mode, decision 30); if a Claude call
  // fails, the keyword fallback reads the reply at low confidence, so a reply is never silently dropped.
  const extractor = withHeuristicFallback(claudeExtractor({ apiKey: env.ANTHROPIC_API_KEY!, model: env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5", ...(env.ANTHROPIC_WORKSPACE_ID ? { workspaceId: env.ANTHROPIC_WORKSPACE_ID } : {}) }), log);
  // Call hours (local, in each workspace's timezone); escalation timing is HAGGLE_ESCALATE_EMAIL_TO_CALL_S.
  const hours = (env.HAGGLE_CALL_HOURS ?? "9-20").match(/^(\d{1,2})-(\d{1,2})$/);
  const callHours = hours && Number(hours[1]) < Number(hours[2]) && Number(hours[2]) <= 24 ? { start: Number(hours[1]), end: Number(hours[2]) } : { start: 9, end: 20 };
  // Lost webhooks (a 503, the server down, a tunnel gap): the reconciler lists the buyer's mailbox,
  // texts and calls and ingests what isn't stored yet, every HAGGLE_RECONCILE_EVERY_S (default 60 s)
  // and before a negotiation round closes or "all quotes are in" goes out. HAGGLE_RECONCILE=false: off.
  const reconcileOn = env.HAGGLE_RECONCILE !== "false";
  let reconciler: InboundReconciler | null = null;
  const engine = new HaggleEngine({
    repo,
    ...(reconcileOn ? { reconcile: (jobId: string) => reconciler?.sweepJob(jobId) ?? Promise.resolve(0) } : {}),
    email: inkboxEmail(api, buyerMailbox),
    ...(phonePort ? { phone: phonePort } : {}),
    ...(a2aPort ? { a2a: a2aPort } : {}),
    ...(imessagePort ? { imessage: imessagePort } : {}),
    ...(smsPort ? { sms: smsPort } : {}),
    // Inbound callbacks: keep the Voice AI's answering instructions in sync with open requests (calls on only).
    ...(phonePort && env.HAGGLE_SYNC_VOICE_CONTEXT !== "false" ? { voice: voice() } : {}),
    extractor,
    attachments: inkboxAttachments(api, buyerMailbox),
    brain,
    payer: disabledPayer("Payments are not enabled on this server (HAGGLE_ENABLE_PAYMENTS is off); nothing was charged."),
    ...(stripe ? { stripe } : {}),
    // Claude chooses among the planner's truthful counter moves; validated, and the rules decide on any failure.
    strategist: claudeStrategist(createAnthropicClient({ apiKey: env.ANTHROPIC_API_KEY!, ...(env.ANTHROPIC_WORKSPACE_ID ? { workspaceId: env.ANTHROPIC_WORKSPACE_ID } : {}) }), env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5"),
    // Public reviews for real businesses (Google Places), only when a key is configured; never for demo vendors.
    reputation: placesReputation({ ...(env.GOOGLE_PLACES_API_KEY ? { apiKey: env.GOOGLE_PLACES_API_KEY } : {}), log: (event, data) => console.log(JSON.stringify({ level: "info", event, ...data })) }),
    config: {
      mode: "live", inboxDomain: buyerMailbox.split("@")[1]!, sharedInbox: buyerMailbox, collectionWindowMs: 30 * 60_000, negotiationWindowMs: 5 * 60_000,
      approvalTtlMs: 30 * 60_000, globalPaymentCapCents: Number.isInteger(cap) && cap > 0 && cap <= capMax ? cap : 500_000, maxRounds: MAX_ROUNDS,
      defaultSpendingCapCents: 150_000, spendingCapCeilingCents: Number.isInteger(ceiling) && ceiling > 0 ? ceiling : 500_000,
      ...(allowAny ? {} : { recipientAllowlist: allowlist }),
      trustInboundCallerId: env.HAGGLE_TRUST_INBOUND_CALLER_ID === "true",
      ...(Number(env.HAGGLE_CALL_DELAY_S) > 0 ? { callDelayMs: Number(env.HAGGLE_CALL_DELAY_S) * 1000 } : {}),
      ...(Number(env.HAGGLE_ESCALATE_EMAIL_TO_CALL_S) > 0 ? { escalateEmailToCallAfterMs: Number(env.HAGGLE_ESCALATE_EMAIL_TO_CALL_S) * 1000 } : {}),
      callHours, callCooldownMs: 2 * 60_000,
      ...(notifyPhone && /^\+\d{8,15}$/.test(notifyPhone) ? { notifyPhone } : {}),
      // Who the AI assistant acts for in messages to businesses (a request's "Customer" detail wins; default "a customer").
      ...(env.HAGGLE_CUSTOMER_NAME?.trim() ? { customerName: env.HAGGLE_CUSTOMER_NAME.trim().slice(0, 40) } : {}),
      // Approval by email from an outside address (Inkbox only authenticates Inkbox senders): the reply
      // must come from the approver's address with the one-time code. HAGGLE_EMAIL_APPROVAL_BY_CODE=false: off.
      emailApprovalByCode: env.HAGGLE_EMAIL_APPROVAL_BY_CODE !== "false",
      identity: { name: identityInfo.displayName || "Haggle", phone: identityInfo.phoneNumber },
    },
    log,
  });
  brain.useAliases((b) => engine.businessAliases(b));
  reconciler = reconcileOn
    ? new InboundReconciler({
      engine, repo, log,
      sources: {
        mail: { api, buyerMailbox, senderTrust, identityAddresses },
        ...(smsPort ? { texts: { list: listTexts } } : {}),
        ...(phonePort ? { calls: { list: listCalls, transcript } } : {}),
      },
    })
    : null;
  const sweepEvery = Math.max(1, Math.round((Number(env.HAGGLE_RECONCILE_EVERY_S) > 0 ? Number(env.HAGGLE_RECONCILE_EVERY_S) : 60) * 1000 / TICK_MS));
  let ticks = 0;
  const sweep = () => (reconciler ? reconciler.sweepAll().then(() => undefined, (e) => console.error(JSON.stringify({ level: "error", event: "reconcile_failed", error: (e as Error).message }))) : Promise.resolve());
  // Backup tick: deadlines advance even when no agent is calling. One per process: a dev hot reload
  // re-runs this with a new engine, and the old engine's tick (old code) must stop, or two engines
  // advance the same jobs (live 2026-10-18: both parsed one reply).
  // The previous runtime's database pool is closed too: each reload's new pool would otherwise
  // keep its connections and exhaust Supabase's session pool (EMAXCONNSESSION, pool_size 15).
  const g = globalThis as { __haggleTick?: ReturnType<typeof setInterval>; __haggleRepo?: PostgresRepository };
  if (g.__haggleTick) clearInterval(g.__haggleTick);
  const previousRepo = g.__haggleRepo;
  g.__haggleRepo = repo;
  if (previousRepo && previousRepo !== repo) void previousRepo.close().catch(() => {});
  g.__haggleTick = setInterval(() => {
    // Every sweepEvery-th tick, recover lost inbound first so this tick's advance reads it.
    void (ticks++ % sweepEvery === 0 ? sweep() : Promise.resolve()).then(() => repo.listOpenJobs()).then((jobs) => Promise.all(jobs.map((j) => engine.advanceJob(j.id)))).catch((e) => console.error(JSON.stringify({ level: "error", event: "tick_failed", error: (e as Error).message })));
  }, TICK_MS).unref();
  // Anything that arrived while this server was down or restarting.
  setTimeout(() => void sweep(), 5_000).unref();
  console.log(JSON.stringify({ level: "info", event: "live_ready", buyer: buyerMailbox, calls: callsEnabled, call_origin: callsEnabled ? callOrigin : null, a2a: a2aPort !== null, imessage: imessagePort !== null, sms: smsPort !== null, notify: Boolean(notifyPhone), email_approval: env.HAGGLE_EMAIL_APPROVAL_BY_CODE !== "false" ? "code" : "verified-senders-only", payments: stripe ? "stripe-test" : "disabled", payment_ceiling_cents: Number.isInteger(cap) && cap > 0 && cap <= capMax ? cap : 500_000, reputation: env.GOOGLE_PLACES_API_KEY ? "google-places" : "off", allowed_recipients: allowAny ? "any" : allowlist.length, sender_trust: senderTrust.policy, reconcile: reconcileOn ? { every_s: (sweepEvery * TICK_MS) / 1000, mail: true, texts: smsPort !== null, calls: phonePort !== null } : false }));
  // Readiness is re-checked at most every 20 s (one read-only Inkbox call); a failed check is "unknown", not "ready".
  let connected: { at: number; set: Set<string> | null } = { at: 0, set: null };
  const channels = async (): Promise<ChannelStatus> => {
    if (imessagePort || phonePort) {
      if (Date.now() - connected.at > 20_000) connected = { at: Date.now(), set: await connectedNumbers().catch(() => null) };
    }
    return { email: true, imessage: imessagePort !== null, sms: smsPort !== null, phone: phonePort !== null, a2a: a2aPort !== null, connectCommand, connected: connected.set, callsViaSharedLine: callOrigin === "shared_imessage_number" };
  };
  const roster = async () => buildRoster(contacts, await channels());
  if (vendorConfig.errors.length) console.error(JSON.stringify({ level: "warn", event: "demo_vendors_config", errors: vendorConfig.errors }));
  return { mode: "live", engine, brain, missing: [], roster, channels, configErrors: vendorConfig.errors, ...(env.GOOGLE_PLACES_API_KEY ? { placesKey: env.GOOGLE_PLACES_API_KEY } : {}), inkbox: { api, buyerMailbox, webhookSecret: env.INKBOX_WEBHOOK_SECRET!, senderTrust, transcript }, ...(reconciler ? { reconciler } : {}) };
});
