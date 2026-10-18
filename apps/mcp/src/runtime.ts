// Builds the engine for the configured mode. Mock mode (default) needs no credentials and is
// labelled DEMO everywhere; live mode needs every variable below and refuses to start partially.
import { readFileSync } from "node:fs";
import { createMockEngine, fleetBusinesses, PostgresRepository, type BrainAdapter, type HaggleEngine, type InkboxMailApi, type InkboxTrustPolicy, type Persona, type QuoteExtraction } from "@haggle/engine";
import { makeBrain } from "./brain.ts";
import { fixtureFetchers, type PlacesFetch, type WebFetch } from "./fixtures.ts";
import { buildRoster, type ChannelStatus, type RosterEntry } from "./vendors.ts";

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
  /** Mock rehearsals only: a recorded Places/website fixture instead of the network (HAGGLE_PLACES_FIXTURE). */
  placesFetch?: PlacesFetch;
  webFetch?: { fetch: WebFetch; resolve: (host: string) => Promise<string[]> };
  /** Which channels can send right now (the same checks the roster uses), for discovered businesses. */
  channels: () => Promise<ChannelStatus>;
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
  // HAGGLE_MOCK_PERSONAS_FILE: scripted vendors (e.g. the 2026-10-18 rehearsal replies) for demos and
  // visual checks; mock only, always DEMO-labelled.
  const personas = env.HAGGLE_MOCK_PERSONAS_FILE ? loadPersonas(env.HAGGLE_MOCK_PERSONAS_FILE) : undefined;
  const fleet = fleetBusinesses(personas);
  // Rehearsals of restarts: HAGGLE_MOCK_DATABASE_URL (a throwaway Postgres) and HAGGLE_MOCK_BRAIN_FILE keep
  // simulated state across a restart. Never point these at the live database: mock data is DEMO only.
  const brain = makeBrain(fleet, env.HAGGLE_MOCK_BRAIN_FILE ? { HAGGLE_BRAIN_FILE: env.HAGGLE_MOCK_BRAIN_FILE } : { HAGGLE_BRAIN_STORE: "memory" }, { discovery: fleet });
  // HAGGLE_PLACES_FIXTURE rehearses public discovery from recorded responses; then, like live, only the
  // fleet and HAGGLE_ALLOWED_RECIPIENTS may be contacted (found is not authorized).
  const fx = env.HAGGLE_PLACES_FIXTURE ? fixtureFetchers(env.HAGGLE_PLACES_FIXTURE) : null;
  const allow = fx ? [...fleet.flatMap((b) => [b.email, b.phone, b.a2a_card_url].filter((x): x is string => !!x)), ...(env.HAGGLE_ALLOWED_RECIPIENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean)] : null;
  const m = createMockEngine({
    delayScale: Number.isFinite(delayScale) && delayScale >= 0 ? delayScale : 1, brain, ...(personas ? { personas } : {}),
    ...(env.HAGGLE_MOCK_DATABASE_URL ? { repo: new PostgresRepository(env.HAGGLE_MOCK_DATABASE_URL) } : {}),
    ...(allow ? { config: { recipientAllowlist: allow } } : {}),
  });
  // Mock: the simulated fleet plays all six demo vendors; every one is reachable (DEMO).
  // HAGGLE_MOCK_VENDORS=none rehearses a server with no vendor set up (the "Setup needed" board).
  const roster = env.HAGGLE_MOCK_VENDORS === "none" ? buildRoster({}, { email: true, imessage: false, phone: false, a2a: false, connectCommand: "connect @haggle", connected: null, callsViaSharedLine: false }) : fleet.map((b): RosterEntry => ({
    key: b.slug, name: b.name, category: "catering", channel: b.a2a_card_url && m.engine.a2aEnabled ? "a2a" : b.email ? "email" : "phone", played_by: "simulated seller (DEMO)", simulated: true, ready: true,
    ...(b.email ? { email: b.email } : {}), ...(b.phone ? { phone: b.phone } : {}), ...(b.a2a_card_url ? { a2a_card_url: b.a2a_card_url } : {}),
  }));
  brain.useAliases((b) => m.engine.businessAliases(b));
  const channels = async (): Promise<ChannelStatus> => ({ email: true, imessage: false, phone: true, a2a: m.engine.a2aEnabled, connectCommand: "connect @haggle", connected: null, callsViaSharedLine: false });
  runtime = Promise.resolve({
    mode: "mock", engine: m.engine, brain, tick: () => m.fleet.deliverDue(), missing: [], roster: async () => roster, channels,
    ...(fx ? { placesKey: "fixture", placesFetch: fx.places, webFetch: { fetch: fx.web, resolve: fx.resolve } } : {}),
  });
  return runtime;
}

interface PersonaFile { personas: { name: string; email?: string; phone?: string; replies: Record<string, { text: string; extraction: QuoteExtraction }> }[] }

/** Scripted mock vendors from JSON: each trigger (rfq, call, followup, counter, answer) has a fixed reply. */
function loadPersonas(path: string): Persona[] {
  const f = JSON.parse(readFileSync(path, "utf8")) as PersonaFile;
  return f.personas.map((p) => ({
    name: p.name, email: p.email ?? "", ...(p.phone ? { phone: p.phone } : {}), delayMs: 2_000,
    reply: (t) => { const r = p.replies[t]; return r ? { text: r.text, extraction: structuredClone(r.extraction) } : null; },
  }));
}

/** Tests only. */
export function resetRuntime() {
  runtime = null;
}
