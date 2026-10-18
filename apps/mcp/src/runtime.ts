// Builds the engine for the configured mode. Mock mode (default) needs no credentials and is
// labelled DEMO everywhere; live mode needs every variable below and refuses to start partially.
import { createMockEngine, fleetBusinesses, PostgresRepository, type BrainAdapter, type HaggleEngine, type InkboxMailApi, type InkboxTrustPolicy } from "@haggle/engine";
import { makeBrain } from "./brain.ts";
import { buildRoster, type RosterEntry } from "./vendors.ts";

export type Runtime = {
  mode: "mock" | "live";
  engine: HaggleEngine;
  /** The real brain (via the engine's adapter); warm-path tools use `brain.core` and its view mappers. */
  brain: BrainAdapter;
  /** Mock mode: the simulated fleet's delivery pump (the engine also pumps on every wait). */
  tick?: () => Promise<number>;
  /** Live mode: the Inkbox buyer identity and its webhook signing key. */
  inkbox?: { api: InkboxMailApi; buyerMailbox: string; webhookSecret: string; senderTrust: InkboxTrustPolicy; transcript?: (callId: string) => Promise<string> };
  missing: string[];
  /** The demo vendors and whether each can be contacted now (never contacts anyone). */
  roster: () => Promise<RosterEntry[]>;
  /** Google Places key for public discovery/reputation (absent = off; never invented). */
  placesKey?: string;
  /** Operator configuration problems worth showing (bad HAGGLE_DEMO_VENDORS entries). */
  configErrors?: string[];
};

export const LIVE_REQUIRED = ["INKBOX_API_KEY", "INKBOX_WEBHOOK_SECRET", "ANTHROPIC_API_KEY", "SUPABASE_DB_URL"] as const;

let runtime: Promise<Runtime> | null = null;
let liveFactory: ((env: NodeJS.ProcessEnv) => Promise<Runtime>) | null = null;

/** apps/mcp/src/live.ts registers itself so mock-only builds never load live dependencies. */
export function registerLiveFactory(f: (env: NodeJS.ProcessEnv) => Promise<Runtime>) {
  liveFactory = f;
}

/** Environment variables live mode still needs (empty in mock mode). */
export function missingLiveConfig(env = process.env): string[] {
  if (env.HAGGLE_MODE !== "live") return [];
  return LIVE_REQUIRED.filter((k) => !env[k]?.trim());
}

export async function getRuntime(env = process.env): Promise<Runtime> {
  if (runtime) return runtime;
  if (env.HAGGLE_MODE === "live") {
    const missing = missingLiveConfig(env);
    if (missing.length || !liveFactory) throw new Error(`live mode is not configured: missing ${missing.join(", ") || "live factory"}`);
    runtime = liveFactory(env).catch((e) => {
      runtime = null; // let the next call retry (e.g. Inkbox briefly unreachable at boot)
      throw e;
    });
    return runtime;
  }
  const delayScale = Number(env.HAGGLE_SIM_DELAY_SCALE ?? "1");
  // Mock mode never writes simulated profiles to a real database (the brain stays in memory), and
  // discover offers only the simulated fleet, which the mock email/phone ports can play.
  const fleet = fleetBusinesses();
  // Rehearsals of restarts: HAGGLE_MOCK_DATABASE_URL (a throwaway Postgres) and HAGGLE_MOCK_BRAIN_FILE keep
  // simulated state across a restart. Never point these at the live database: mock data is DEMO only.
  const brain = makeBrain(fleet, env.HAGGLE_MOCK_BRAIN_FILE ? { HAGGLE_BRAIN_FILE: env.HAGGLE_MOCK_BRAIN_FILE } : { HAGGLE_BRAIN_STORE: "memory" }, { discovery: fleet });
  const m = createMockEngine({
    delayScale: Number.isFinite(delayScale) && delayScale >= 0 ? delayScale : 1, brain,
    ...(env.HAGGLE_MOCK_DATABASE_URL ? { repo: new PostgresRepository(env.HAGGLE_MOCK_DATABASE_URL) } : {}),
  });
  // Mock: the simulated fleet plays all six demo vendors; every one is reachable (DEMO).
  // HAGGLE_MOCK_VENDORS=none rehearses a server with no vendor set up (the "Setup needed" board).
  const roster = env.HAGGLE_MOCK_VENDORS === "none" ? buildRoster({}, { email: true, imessage: false, phone: false, a2a: false, connectCommand: "connect @haggle", connected: null, callsViaSharedLine: false }) : fleet.map((b): RosterEntry => ({
    key: b.slug, name: b.name, channel: b.a2a_card_url && m.engine.a2aEnabled ? "a2a" : b.email ? "email" : "phone", played_by: "simulated seller (DEMO)", simulated: true, ready: true,
    ...(b.email ? { email: b.email } : {}), ...(b.phone ? { phone: b.phone } : {}), ...(b.a2a_card_url ? { a2a_card_url: b.a2a_card_url } : {}),
  }));
  runtime = Promise.resolve({ mode: "mock", engine: m.engine, brain, tick: () => m.fleet.deliverDue(), missing: [], roster: async () => roster });
  return runtime;
}

/** Tests only. */
export function resetRuntime() {
  runtime = null;
}
