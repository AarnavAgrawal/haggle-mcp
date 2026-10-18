// The real brain (@haggle/brain) behind the engine's adapter. Profiles go to Supabase when
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set (needs migration 200_brain_profiles), else to
// HAGGLE_BRAIN_FILE / memory (see .env.example). Seeded so warm asks work from minute one.
//
// Resilience: HAGGLE_BRAIN_STORE=memory always wins (storeFromEnv prefers Supabase whenever its
// keys exist), and a failing start-up (seed / profile load, e.g. Supabase unreachable or missing
// grants) is logged instead of crashing the MCP server: brain calls then fail per request and the
// engine keeps working (learnFromReply failures never block a deal).
import { createBrain, loadDirectory, storeFromEnv, type ProfileStore } from "@haggle/brain";
import type { Profile } from "@haggle/core";
import { BrainAdapter, type BrainAdapterOptions, type EngineContact } from "@haggle/engine";

export function brainStoreEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.HAGGLE_BRAIN_STORE !== "memory") return env;
  const { SUPABASE_URL: _u, SUPABASE_SERVICE_ROLE_KEY: _k, ...rest } = env;
  return rest;
}

const isSeedJob = (jobId: string) => jobId.startsWith("job_seed");
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : undefined; };
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A profile as Haggle actually observed it: seed sample rows (fixtures/brain/seed-replies.json, job ids
 * "job_seed…") removed and the numbers derived from them recomputed from real quotes only (same rules
 * as the brain's learn step). null when nothing real is left, so a sample is never shown, estimated
 * from, price-checked against or cited as this business's history.
 */
export function observedOnly(p: Profile | null): Profile | null {
  if (!p) return null;
  const history = p.history.filter((h) => !isSeedJob(h.job_id));
  if (history.length === p.history.length) return p;
  if (!history.length) return null;
  const quotes = history.filter((h) => h.kind === "quote");
  const perUnits = quotes.map((h) => h.per_unit_usd).filter((n): n is number => n !== undefined);
  const typical = median(perUnits);
  const { per_unit_usd: _p, ...rest } = p;
  return {
    ...rest, history, n_quotes: quotes.length,
    confidence: round2(Math.min(0.95, Math.max(0.2, 0.3 + 0.18 * quotes.length))),
    ...(typical === undefined ? {} : { per_unit_usd: { low: round2(Math.min(...perUnits)), typical: round2(typical), high: round2(Math.max(...perUnits)) } }),
  };
}

/** Live: the store seen through observedOnly. A learn step reads the cleaned profile, so it writes it back clean. */
export function observedStore(store: ProfileStore): ProfileStore {
  return {
    get: async (id) => observedOnly(await store.get(id)),
    list: async () => (await store.list()).map(observedOnly).filter((p): p is Profile => p !== null),
    put: (p) => store.put(p),
  };
}

/**
 * `observed: true` (live): synthetic seed samples are never replayed and never read back. Mock keeps
 * them so simulated demos have warm estimates from minute one (always labelled as samples).
 */
export function makeBrain(fleet: EngineContact[], env: NodeJS.ProcessEnv = process.env, extra: Pick<BrainAdapterOptions, "discovery"> & { observed?: boolean } = {}): BrainAdapter {
  const { observed = false, ...rest } = extra;
  const base = storeFromEnv(brainStoreEnv(env));
  const core = createBrain({ store: observed ? observedStore(base) : base, seed: !observed });
  core.ready.catch((e: unknown) => {
    console.error(JSON.stringify({ level: "warn", event: "brain_start_failed", error: String((e as Error)?.message ?? e).slice(0, 200), hint: "check SUPABASE_URL and grants on brain_profiles, or set HAGGLE_BRAIN_STORE=memory" }));
  });
  // The default directory is the synthetic seed set: live identities never map onto it.
  return new BrainAdapter({ brain: core, directory: observed ? [] : loadDirectory(), fleet, ...rest });
}
