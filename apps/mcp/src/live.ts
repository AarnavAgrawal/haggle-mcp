// LIVE MODE wiring (HAGGLE_MODE=live), v5: Postgres persistence, the Inkbox buyer identity for
// email (+ attachments), Claude extraction, and the real brain (@haggle/brain via the engine's
// adapter; profiles in Supabase when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set). Voice AI calls stay OFF unless HAGGLE_ENABLE_CALLS=true (separate
// human approval; only simulated businesses or people who agreed). A2A tasks and iMessage (approvals and
// texting businesses that connected first) are also opt-in. Payments: Stripe TEST MODE only
// when HAGGLE_ENABLE_PAYMENTS=true and the key is sk_test_ (refuses to start otherwise); without the
// flag every payment is refused (disabledPayer), never faked. No Primitive/x402 keys.
import {
  businessIdFor, claudeExtractor, connectInkboxBuyer, disabledPayer, heuristicExtractor, InboundReconciler, stripeTestPayments, type InkboxTrustPolicy, HaggleEngine, inkboxAttachments, inkboxEmail, parseFleet, PostgresRepository, slugify,
  withHeuristicFallback,
} from "@haggle/engine";
import { makeBrain } from "./brain.ts";
import { registerLiveFactory, type Runtime } from "./runtime.ts";

const TICK_MS = 30_000;

registerLiveFactory(async (env): Promise<Runtime> => {
  const { api, buyerMailbox, phone, a2a, imessage, sms, voice, identityInfo, transcript, callOrigin, identityAddresses, listTexts, listCalls } = await connectInkboxBuyer({ apiKey: env.INKBOX_API_KEY!, handle: env.INKBOX_IDENTITY?.trim() || "haggle" });

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
    config: {
      mode: "live", inboxDomain: buyerMailbox.split("@")[1]!, sharedInbox: buyerMailbox, collectionWindowMs: 30 * 60_000, negotiationWindowMs: 5 * 60_000,
      approvalTtlMs: 30 * 60_000, globalPaymentCapCents: Number.isInteger(cap) && cap > 0 && cap <= capMax ? cap : stripe ? 50_000 : 500, maxRounds: 2,
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
  console.log(JSON.stringify({ level: "info", event: "live_ready", buyer: buyerMailbox, calls: callsEnabled, call_origin: callsEnabled ? callOrigin : null, a2a: a2aPort !== null, imessage: imessagePort !== null, sms: smsPort !== null, notify: Boolean(notifyPhone), email_approval: env.HAGGLE_EMAIL_APPROVAL_BY_CODE !== "false" ? "code" : "verified-senders-only", payments: stripe ? "stripe-test" : "disabled", allowed_recipients: allowAny ? "any" : allowlist.length, sender_trust: senderTrust.policy, reconcile: reconcileOn ? { every_s: (sweepEvery * TICK_MS) / 1000, mail: true, texts: smsPort !== null, calls: phonePort !== null } : false }));
  return { mode: "live", engine, brain, missing: [], inkbox: { api, buyerMailbox, webhookSecret: env.INKBOX_WEBHOOK_SECRET!, senderTrust, transcript }, ...(reconciler ? { reconciler } : {}) };
});
