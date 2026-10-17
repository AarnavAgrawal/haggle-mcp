// The real brain (@haggle/brain) behind the engine's adapter. Profiles go to Supabase when
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set (needs migration 200_brain_profiles), else to
// HAGGLE_BRAIN_FILE / memory (see .env.example). Seeded so warm asks work from minute one.
//
// Resilience: HAGGLE_BRAIN_STORE=memory always wins (storeFromEnv prefers Supabase whenever its
// keys exist), and a failing start-up (seed / profile load, e.g. Supabase unreachable or missing
// grants) is logged instead of crashing the MCP server: brain calls then fail per request and the
// engine keeps working (learnFromReply failures never block a deal).
import { createBrain, loadDirectory, storeFromEnv } from "@haggle/brain";
import { BrainAdapter, type BrainAdapterOptions, type EngineContact } from "@haggle/engine";

export function brainStoreEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.HAGGLE_BRAIN_STORE !== "memory") return env;
  const { SUPABASE_URL: _u, SUPABASE_SERVICE_ROLE_KEY: _k, ...rest } = env;
  return rest;
}

export function makeBrain(fleet: EngineContact[], env: NodeJS.ProcessEnv = process.env, extra: Pick<BrainAdapterOptions, "discovery"> = {}): BrainAdapter {
  const core = createBrain({ store: storeFromEnv(brainStoreEnv(env)), seed: true });
  core.ready.catch((e: unknown) => {
    console.error(JSON.stringify({ level: "warn", event: "brain_start_failed", error: String((e as Error)?.message ?? e).slice(0, 200), hint: "check SUPABASE_URL and grants on brain_profiles, or set HAGGLE_BRAIN_STORE=memory" }));
  });
  return new BrainAdapter({ brain: core, directory: loadDirectory(), fleet, ...extra });
}
