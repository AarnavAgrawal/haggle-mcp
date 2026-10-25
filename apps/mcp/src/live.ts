// LIVE MODE wiring (HAGGLE_MODE=live), v5: Postgres persistence, the Inkbox buyer identity for
// email (+ attachments), Claude extraction, and the real brain (@haggle/brain via the engine's
// adapter; profiles in Supabase when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set). Voice AI calls stay OFF unless HAGGLE_ENABLE_CALLS=true (separate
// human approval; only simulated businesses or people who agreed). A2A tasks and iMessage (approvals and
// texting businesses that connected first) are also opt-in. Payments: Stripe TEST MODE only
// when HAGGLE_ENABLE_PAYMENTS=true and the key is sk_test_ (refuses to start otherwise); without the
// flag every payment is refused (disabledPayer), never faked. No Primitive/x402 keys.
import {
  businessIdForContact, MAX_ROUNDS, claudeExtractor, claudeStrategist, createAnthropicClient, placesReputation, connectInkboxBuyer, disabledPayer, InboundReconciler, stripeTestPayments, type InkboxTrustPolicy, HaggleEngine, inkboxAttachments, inkboxEmail, parseFleet, PostgresRepository, slugify,
  withHeuristicFallback, AiUsageMeter, aiUsageSink, aiLimitsFromEnv, hydrateAiMeter, createAlerter, createLogger, meteredClient, meteredExtractor, StalledJobMonitor, DEFAULT_STALL_THRESHOLDS, contactWindowFromEnv, alertingLog,
} from "@haggle/engine";
import { haggleEnv } from "./config.ts";
import { storeFromEnv } from "@haggle/brain";
import { brainStoreEnv, makeBrain, probeBrainSchema } from "./brain.ts";
import { registerLiveFactory, type Runtime } from "./runtime.ts";
import { liveTimings } from "./timings.ts";
import { emailApprovalByCode } from "./workspace.ts";
import { buildRoster, DEMO_VENDORS, parseVendorConfig, rosterRecipients, type ChannelStatus, type VendorContact } from "./vendors.ts";

registerLiveFactory(async (env): Promise<Runtime> => {
  // One redacting JSON logger for everything this file and the engine log (emails, phones, keys masked).
  const deployEnv = haggleEnv(env);
  const logger = createLogger({ fields: { service: "haggle-mcp", env: deployEnv }, level: (["debug", "info", "warn", "error"] as const).find((l) => l === env.HAGGLE_LOG_LEVEL) ?? "info" });
  // Operator alerts (HAGGLE_ALERT_WEBHOOK_URL, Slack-compatible): stalled jobs, AI limits, background failures.
  const alerts = createAlerter({ url: env.HAGGLE_ALERT_WEBHOOK_URL?.trim(), logger, source: `haggle ${deployEnv}` });
  // Haggle's own waits; HAGGLE_DEMO_SPEED=true shortens them for a short demo video (decision 49).
  const timings = liveTimings(env);
  const TICK_MS = timings.tickMs;
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
  // A query waits at most HAGGLE_DB_QUEUE_TIMEOUT_MS (default 5 s; config.ts validates 100-60000) for a
  // free pooled connection, then fails as transient: polling boards can't queue without limit.
  const queueTimeoutMs = Number(env.HAGGLE_DB_QUEUE_TIMEOUT_MS ?? "5000");
  const repo = new PostgresRepository(env.SUPABASE_DB_URL!, {
    max: Number.isInteger(poolMax) && poolMax >= 1 && poolMax <= 10 ? poolMax : 4, ...(env.HAGGLE_DB_SCHEMA?.trim() ? { schema: env.HAGGLE_DB_SCHEMA.trim() } : {}),
    queueTimeoutMs: Number.isInteger(queueTimeoutMs) && queueTimeoutMs >= 100 && queueTimeoutMs <= 60_000 ? queueTimeoutMs : 5_000, applicationName: `haggle-mcp-${deployEnv}`,
  });
  // Each outbound channel is OFF unless explicitly enabled (real calls / iMessages / A2A tasks need
  // Yash's go-ahead). A2A cards and phone numbers must still be on the recipient allowlist; iMessage
  // only ever goes to the settings approver.
  const phonePort = env.HAGGLE_ENABLE_CALLS === "true" ? phone() : null;
  const callsEnabled = phonePort !== null;
  if (env.HAGGLE_ENABLE_CALLS === "true" && !phonePort) logger.warn("calls_unavailable", { reason: "the buyer identity has no phone number and iMessage is off" });
  const a2aPort = env.HAGGLE_ENABLE_A2A === "true" ? a2a() : null;
  const imessagePort = env.HAGGLE_ENABLE_IMESSAGE === "true" ? imessage() : null;
  // SMS from the buyer's own number: update texts to HAGGLE_NOTIFY_PHONE (else the settings approver)
  // and one follow-up text to an allowlisted phone business whose call left the total unclear.
  const smsPort = env.HAGGLE_ENABLE_SMS === "true" ? sms() : null;
  if (env.HAGGLE_ENABLE_SMS === "true" && !smsPort) logger.warn("sms_unavailable", { reason: "the buyer identity has no SMS-ready phone number" });
  const notifyPhone = env.HAGGLE_NOTIFY_PHONE?.replace(/[\s().-]/g, "");
  // Never contact arbitrary businesses: only the simulated fleet and explicitly allowed recipients.
  // Live outreach is always allowlisted: the operator's list plus each workspace's authorized vendors
  // (workspace-admin add-vendor). HAGGLE_ALLOW_ANY_RECIPIENT is ignored here (a warning is logged).
  if (env.HAGGLE_ALLOW_ANY_RECIPIENT === "true") logger.warn("allow_any_recipient_ignored", { reason: "live outreach needs per-workspace vendor authorization" });
  const allowAny = false;
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
  // One profile store: the brain's, and the one /ready and the start-up probe check for 202_brain_tenancy.
  const brainStore = storeFromEnv(brainStoreEnv(env));
  const brain = makeBrain([...fleet.map((b) => ({ business_id: b.business_id, name: b.name, email: b.email, simulated: b.simulated })), ...vendorIdentities], env, { observed: true, store: brainStore });
  void probeBrainSchema(brainStore, logger);
  // Engine and reconciler events that need a person (operator review, lease lost, send not recorded…) also alert.
  const log = alertingLog(logger.engine, alerts);
  // AI usage controls (HAGGLE_AI_MAX_CALLS_PER_JOB, HAGGLE_AI_DAILY_TOKEN_BUDGET): every Claude call is
  // metered; over a limit it is refused and the reply waits for a human (never a keyword quote).
  const ai = new AiUsageMeter({
    limits: aiLimitsFromEnv(env), logger,
    // Each call's reported usage is kept per job (ai_usage_events, 122) for metrics; best effort.
    sink: aiUsageSink(repo),
    workspaceOf: async (jobId) => (await repo.getJob(jobId))?.workspace_id ?? null,
    onLimit: ({ limit, scope }) => void alerts.alert({ key: `ai_limit:${limit}:${limit === "daily_tokens" ? "day" : scope.jobId ?? "?"}`, severity: "warn", summary: limit === "daily_tokens" ? "AI daily token budget reached: new replies are held for human review until the UTC day rolls over" : `AI call limit reached for job ${scope.jobId}: its new replies are held for human review`, details: { limit, job_id: scope.jobId ?? null } }),
  });
  // Claude reads replies (ANTHROPIC_API_KEY is required in live mode, decision 30); if Claude refuses
  // or returns nothing, the keyword fallback reads the reply at low confidence (never approvable).
  const extractor = meteredExtractor(withHeuristicFallback(claudeExtractor({ apiKey: env.ANTHROPIC_API_KEY!, model: env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5", meter: ai, ...(env.ANTHROPIC_WORKSPACE_ID ? { workspaceId: env.ANTHROPIC_WORKSPACE_ID } : {}) }), log), ai);
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
    strategist: claudeStrategist(meteredClient(createAnthropicClient({ apiKey: env.ANTHROPIC_API_KEY!, ...(env.ANTHROPIC_WORKSPACE_ID ? { workspaceId: env.ANTHROPIC_WORKSPACE_ID } : {}) }), ai, "strategist"), env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5"),
    // Public reviews for real businesses (Google Places), only when a key is configured; never for demo vendors.
    reputation: placesReputation({ ...(env.GOOGLE_PLACES_API_KEY ? { apiKey: env.GOOGLE_PLACES_API_KEY } : {}), log }),
    config: {
      mode: "live", inboxDomain: buyerMailbox.split("@")[1]!, sharedInbox: buyerMailbox, ...timings.engine,
      approvalTtlMs: 30 * 60_000, globalPaymentCapCents: Number.isInteger(cap) && cap > 0 && cap <= capMax ? cap : 500_000, maxRounds: MAX_ROUNDS,
      defaultSpendingCapCents: 150_000, spendingCapCeilingCents: Number.isInteger(ceiling) && ceiling > 0 ? ceiling : 500_000,
      ...(allowAny ? {} : { recipientAllowlist: allowlist }),
      trustInboundCallerId: env.HAGGLE_TRUST_INBOUND_CALLER_ID === "true",
      // HAGGLE_CALL_DELAY_S and HAGGLE_ESCALATE_EMAIL_TO_CALL_S are read by liveTimings (timings.engine).
      callHours,
      ...(notifyPhone && /^\+\d{8,15}$/.test(notifyPhone) ? { notifyPhone } : {}),
      // Who the AI assistant acts for in messages to businesses (a request's "Customer" detail wins; default "a customer").
      ...(env.HAGGLE_CUSTOMER_NAME?.trim() ? { customerName: env.HAGGLE_CUSTOMER_NAME.trim().slice(0, 40) } : {}),
      // Approval by email from an outside address (Inkbox only authenticates Inkbox senders) rests on a
      // spoofable From: off unless the operator sets HAGGLE_EMAIL_APPROVAL_BY_CODE=true.
      emailApprovalByCode: emailApprovalByCode(env),
      // Live: only the approver's own coded reply approves (never a tool call, form or card button).
      outOfBandApprovalsOnly: true,
      // The signed-in account owner's click in the web app (service routes only; MCP tools unchanged).
      webApprovals: !/^(false|0|off|no)$/i.test(env.HAGGLE_WEB_APPROVALS?.trim() ?? ""),
      // Pilot: no money moves through Haggle (the human pays the business; HAGGLE_PAYMENTS=manual).
      ...(env.HAGGLE_PAYMENTS === "manual" ? { manualPaymentHandoff: true } : {}),
      // Vendors are contacted only in business hours (default Mon-Sat 08:00-19:00 America/Los_Angeles; HAGGLE_CONTACT_HOURS=off disables).
      ...(() => { const w = contactWindowFromEnv(env); return w ? { contactWindow: w } : {}; })(),
      // Replies from real mailboxes (Gmail, Outlook): only with the reply token (HAGGLE_EXTERNAL_SENDERS=reply_token).
      ...(env.HAGGLE_EXTERNAL_SENDERS === "reply_token" ? { externalSenders: "reply_token" as const, replyTokenSecret: env.HAGGLE_REPLY_TOKEN_SECRET ?? "" } : {}),
      ...(env.HAGGLE_VOICE_WORKSPACE?.trim() ? { voiceWorkspaceId: env.HAGGLE_VOICE_WORKSPACE.trim() } : {}),
      identity: { name: identityInfo.displayName || "Haggle", phone: identityInfo.phoneNumber },
    },
    log,
  });
  brain.useAliases((b) => engine.businessAliases(b));
  reconciler = reconcileOn
    ? new InboundReconciler({
      engine, repo, jobMinIntervalMs: timings.reconcileJobMinIntervalMs, callGraceMs: timings.reconcileCallGraceMs,
      // An item the sweep gave up on goes to operator review instead of being retried silently forever.
      log: (event, data) => {
        log(event, data);
        if (event === "reconcile_gave_up") void engine.reportReconcileGaveUp({ key: String(data.key), attempts: 5, error: data.error }).catch((e) => backgroundFailed("operator_review_failed", e));
      },
      sources: {
        mail: { api, buyerMailbox, senderTrust, identityAddresses },
        ...(smsPort ? { texts: { list: listTexts } } : {}),
        ...(phonePort ? { calls: { list: listCalls, transcript } } : {}),
      },
    })
    : null;
  const sweepEvery = Math.max(1, Math.round(timings.reconcileEveryMs / TICK_MS));
  let ticks = 0;
  // A background failure is logged every time and alerted (deduplicated: at most once per 30 min per kind).
  const backgroundFailed = (event: string, e: unknown) => {
    logger.error(event, { error: e });
    void alerts.alert({ key: event, severity: "warn", summary: `${event.replace(/_/g, " ")} on the live server`, details: { error: (e as Error)?.message?.slice(0, 200) ?? String(e) } });
  };
  const sweep = () => (reconciler ? reconciler.sweepAll().then(() => undefined, (e) => backgroundFailed("reconcile_failed", e)) : Promise.resolve());
  // Backup tick: deadlines advance even when no agent is calling. One per process: a dev hot reload
  // re-runs this with a new engine, and the old engine's tick (old code) must stop, or two engines
  // advance the same jobs (live 2026-10-18: both parsed one reply).
  // The previous runtime's database pool is closed too: each reload's new pool would otherwise
  // keep its connections and exhaust Supabase's session pool (EMAXCONNSESSION, pool_size 15).
  const g = globalThis as { __haggleTick?: ReturnType<typeof setInterval>; __haggleRepo?: PostgresRepository; __haggleStall?: ReturnType<typeof setInterval>; __haggleAiHydrate?: ReturnType<typeof setInterval> };
  if (g.__haggleTick) clearInterval(g.__haggleTick);
  if (g.__haggleStall) clearInterval(g.__haggleStall);
  if (g.__haggleAiHydrate) clearInterval(g.__haggleAiHydrate);
  // AI limits across restarts and replicas: today's persisted usage (ai_usage_events) raises the meter's
  // counts now and every 60 s (the max of memory and the store; admit stays synchronous). Best effort.
  const hydrateAi = () => hydrateAiMeter(ai, repo).then(() => undefined, (e) => logger.warn("ai_usage_hydrate_failed", { error: (e as Error)?.message?.slice(0, 200) ?? String(e) }));
  void hydrateAi();
  g.__haggleAiHydrate = setInterval(() => void hydrateAi(), 60_000).unref();
  const previousRepo = g.__haggleRepo;
  g.__haggleRepo = repo;
  if (previousRepo && previousRepo !== repo) void previousRepo.close().catch(() => {});
  // Stuck-job recovery (workflow/recovery.ts) every ~2 minutes: overdue work advanced, the rest to operator review.
  const recoverEvery = Math.max(1, Math.round(120_000 / TICK_MS));
  g.__haggleTick = setInterval(() => {
    if (ticks % recoverEvery === 0) void engine.recoverStuck({ advanceOpen: false }).catch((e) => backgroundFailed("recovery_failed", e));
    // Every sweepEvery-th tick, recover lost inbound first so this tick's advance reads it.
    // Each advance runs in its job's AI scope, so the strategist and question answers count toward it.
    void (ticks++ % sweepEvery === 0 ? sweep() : Promise.resolve()).then(() => repo.listOpenJobs()).then((jobs) => Promise.all(jobs.map((j) => ai.run({ jobId: j.id, workspaceId: j.workspace_id }, () => engine.advanceJob(j.id))))).catch((e) => backgroundFailed("tick_failed", e));
  }, TICK_MS).unref();
  // Stalled jobs: a read-only check every HAGGLE_STALL_CHECK_EVERY_S (default 300; 0 = off), logged and alerted.
  const stallEveryS = Number(env.HAGGLE_STALL_CHECK_EVERY_S ?? "300");
  const stalled = new StalledJobMonitor({ repo, thresholds: DEFAULT_STALL_THRESHOLDS, log: (event, data) => logger.warn(event, data), alert: (a) => alerts.alert(a) });
  if (Number.isFinite(stallEveryS) && stallEveryS > 0) {
    g.__haggleStall = setInterval(() => void stalled.check().catch((e) => backgroundFailed("stall_check_failed", e)), stallEveryS * 1000).unref();
    setTimeout(() => void stalled.check().catch((e) => backgroundFailed("stall_check_failed", e)), 30_000).unref();
  }
  // Anything that arrived while this server was down or restarting.
  setTimeout(() => void sweep(), 5_000).unref();
  logger.info("live_ready", { buyer: buyerMailbox, ai_limits: ai.snapshot().limits, alerts: alerts.enabled, stall_check_s: stallEveryS > 0 ? stallEveryS : false, demo_speed: timings.demoSpeed, tick_s: TICK_MS / 1000, calls: callsEnabled, call_origin: callsEnabled ? callOrigin : null, a2a: a2aPort !== null, imessage: imessagePort !== null, sms: smsPort !== null, notify: Boolean(notifyPhone), email_approval: emailApprovalByCode(env) ? "code" : "verified-senders-only", payments: env.HAGGLE_PAYMENTS === "manual" ? "manual-handoff" : stripe ? "stripe-test" : "disabled", external_senders: env.HAGGLE_EXTERNAL_SENDERS === "reply_token" ? "reply_token" : "off", payment_ceiling_cents: Number.isInteger(cap) && cap > 0 && cap <= capMax ? cap : 500_000, reputation: env.GOOGLE_PLACES_API_KEY ? "google-places" : "off", allowed_recipients: allowAny ? "any" : allowlist.length, sender_trust: senderTrust.policy, reconcile: reconcileOn ? { every_s: (sweepEvery * TICK_MS) / 1000, mail: true, texts: smsPort !== null, calls: phonePort !== null } : false });
  // Readiness is re-checked at most every 20 s (one read-only Inkbox call); a failed check is "unknown", not "ready".
  let connected: { at: number; set: Set<string> | null } = { at: 0, set: null };
  const channels = async (): Promise<ChannelStatus> => {
    if (imessagePort || phonePort) {
      if (Date.now() - connected.at > 20_000) connected = { at: Date.now(), set: await connectedNumbers().catch(() => null) };
    }
    return { email: true, imessage: imessagePort !== null, sms: smsPort !== null, phone: phonePort !== null, a2a: a2aPort !== null, connectCommand, connected: connected.set, callsViaSharedLine: callOrigin === "shared_imessage_number" };
  };
  const roster = async () => buildRoster(contacts, await channels());
  if (vendorConfig.errors.length) logger.warn("demo_vendors_config", { errors: vendorConfig.errors });
  const ops = {
    env: deployEnv, repo, database: "postgres" as const, ai, alerts, stalled, pool: () => repo.poolStats(),
    ...(brainStore.checkSchema ? { brain: { checkSchema: () => brainStore.checkSchema!() } } : {}),
    providers: { inkbox: true, anthropic: true, payments: env.HAGGLE_PAYMENTS === "manual" ? "manual" as const : stripe ? "stripe_test" as const : "disabled" as const, alerts: alerts.enabled },
  };
  return { mode: "live", engine, brain, missing: [], roster, channels, configErrors: vendorConfig.errors, ops, ...(env.GOOGLE_PLACES_API_KEY ? { placesKey: env.GOOGLE_PLACES_API_KEY } : {}), inkbox: { api, buyerMailbox, webhookSecret: env.INKBOX_WEBHOOK_SECRET!, senderTrust, transcript }, ...(reconciler ? { reconciler } : {}) };
});
