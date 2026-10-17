// LIVE MODE wiring (HAGGLE_MODE=live), v5: Postgres persistence, the Inkbox buyer identity for
// email (+ attachments), Claude extraction, and the brain (engine stand-in until Partner's
// @haggle/brain is published). Voice AI calls stay OFF unless HAGGLE_ENABLE_CALLS=true (separate
// human approval; only simulated businesses or people who agreed). Payments: the x402 payer is
// kept from v3 and refuses without a testnet key; Stripe test mode is the 9 PM item.
import {
  businessIdFor, claudeExtractor, connectInkboxBuyer, HaggleEngine, inkboxAttachments, inkboxEmail, parseFleet, PostgresRepository, StubBrain, slugify, x402Payer,
} from "@haggle/engine";
import { registerLiveFactory, type Runtime } from "./runtime.ts";

const TICK_MS = 30_000;

registerLiveFactory(async (env): Promise<Runtime> => {
  const { api, buyerMailbox, phone } = await connectInkboxBuyer({ apiKey: env.INKBOX_API_KEY!, handle: env.INKBOX_IDENTITY?.trim() || "haggle" });

  // Only the explicitly configured simulated fleet is offered by discover (never arbitrary businesses).
  const fleet = parseFleet(env.HAGGLE_DEMO_FLEET).map((b) => ({
    business_id: businessIdFor(b.email), slug: slugify(b.name), name: b.name, email: b.email, source: "fleet" as const, simulated: true, found_at: "HAGGLE_DEMO_FLEET",
  }));
  const cap = Number(env.HAGGLE_GLOBAL_PAYMENT_CAP_CENTS ?? "500");
  const ceiling = Number(env.HAGGLE_SPENDING_CAP_CEILING_CENTS ?? "500000");
  const repo = new PostgresRepository(env.SUPABASE_DB_URL!);
  const callsEnabled = env.HAGGLE_ENABLE_CALLS === "true";
  const engine = new HaggleEngine({
    repo,
    email: inkboxEmail(api, buyerMailbox),
    ...(callsEnabled ? { phone: phone() } : {}),
    extractor: claudeExtractor({ apiKey: env.ANTHROPIC_API_KEY!, model: env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5", ...(env.ANTHROPIC_WORKSPACE_ID ? { workspaceId: env.ANTHROPIC_WORKSPACE_ID } : {}) }),
    attachments: inkboxAttachments(api, buyerMailbox),
    brain: new StubBrain(fleet),
    payer: x402Payer({ apiKey: env.PRIMITIVE_API_KEY ?? "", privateKey: env.HAGGLE_PAYER_PRIVATE_KEY }),
    config: {
      mode: "live", inboxDomain: buyerMailbox.split("@")[1]!, sharedInbox: buyerMailbox, collectionWindowMs: 30 * 60_000, negotiationWindowMs: 15 * 60_000,
      approvalTtlMs: 30 * 60_000, globalPaymentCapCents: Number.isInteger(cap) && cap > 0 && cap <= 1000 ? cap : 500, maxRounds: 2,
      defaultSpendingCapCents: 150_000, spendingCapCeilingCents: Number.isInteger(ceiling) && ceiling > 0 ? ceiling : 500_000,
    },
    log: (event, data) => console.log(JSON.stringify({ level: "info", event, ...data })),
  });
  // Backup tick: deadlines advance even when no agent is calling.
  setInterval(() => {
    void repo.listOpenJobs().then((jobs) => Promise.all(jobs.map((j) => engine.advanceJob(j.id)))).catch((e) => console.error(JSON.stringify({ level: "error", event: "tick_failed", error: (e as Error).message })));
  }, TICK_MS).unref();
  console.log(JSON.stringify({ level: "info", event: "live_ready", buyer: buyerMailbox, calls: callsEnabled }));
  return { mode: "live", engine, missing: [], inkbox: { api, buyerMailbox, webhookSecret: env.INKBOX_WEBHOOK_SECRET! } };
});
