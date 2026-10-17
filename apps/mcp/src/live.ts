// LIVE MODE wiring (HAGGLE_MODE=live): Postgres persistence, Primitive email + attachments,
// Claude extraction, x402 payer, and the brain (engine stand-in until Partner's @haggle/brain is
// published). Loaded by index.ts; refuses to start unless every required variable is present.
import { businessIdFor, claudeExtractor, HaggleEngine, parseFleet, PostgresRepository, primitiveAttachments, primitiveEmail, StubBrain, x402Payer, slugify } from "@haggle/engine";
import { registerLiveFactory, type Runtime } from "./runtime.ts";

const TICK_MS = 30_000;

registerLiveFactory(async (env): Promise<Runtime> => {
  const apiKey = env.PRIMITIVE_API_KEY!;
  const fleet = parseFleet(env.HAGGLE_DEMO_FLEET).map((b) => ({
    business_id: businessIdFor(b.email), slug: slugify(b.name), name: b.name, email: b.email, source: "fleet" as const, simulated: true, found_at: "HAGGLE_DEMO_FLEET",
  }));
  const cap = Number(env.HAGGLE_GLOBAL_PAYMENT_CAP_CENTS ?? "500");
  const repo = new PostgresRepository(env.SUPABASE_DB_URL!);
  const engine = new HaggleEngine({
    repo,
    email: primitiveEmail(apiKey),
    extractor: claudeExtractor({ apiKey: env.ANTHROPIC_API_KEY!, model: env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5", ...(env.ANTHROPIC_WORKSPACE_ID ? { workspaceId: env.ANTHROPIC_WORKSPACE_ID } : {}) }),
    attachments: primitiveAttachments(apiKey),
    brain: new StubBrain(fleet),
    payer: x402Payer({ apiKey, privateKey: env.HAGGLE_PAYER_PRIVATE_KEY }),
    config: {
      mode: "live", inboxDomain: env.HAGGLE_INBOX_DOMAIN!.toLowerCase(), collectionWindowMs: 30 * 60_000, negotiationWindowMs: 15 * 60_000,
      approvalTtlMs: 30 * 60_000, globalPaymentCapCents: Number.isInteger(cap) && cap > 0 && cap <= 1000 ? cap : 500, maxRounds: 2,
    },
    log: (event, data) => console.log(JSON.stringify({ level: "info", event, ...data })),
  });
  // Backup tick (quote-broker's /internal/tick idea): deadlines advance even when no agent is calling.
  setInterval(() => {
    void repo.listOpenJobs().then((jobs) => Promise.all(jobs.map((j) => engine.advanceJob(j.id)))).catch((e) => console.error(JSON.stringify({ level: "error", event: "tick_failed", error: (e as Error).message })));
  }, TICK_MS).unref();
  return {
    mode: "live", engine, missing: [],
    webhook: { secret: env.PRIMITIVE_WEBHOOK_SECRET!, ...(env.PRIMITIVE_WEBHOOK_ENDPOINT_ID ? { endpointId: env.PRIMITIVE_WEBHOOK_ENDPOINT_ID } : {}), inboxDomain: env.HAGGLE_INBOX_DOMAIN! },
  };
});
