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
  return historyOnly(p, (jobId) => !isSeedJob(jobId));
}

/**
 * A profile with only the history rows whose deal `keep` accepts, and everything derived from the
 * others dropped or recomputed (as observedOnly). Profiles are shared across workspaces: an agent is
 * shown its own workspace's rows only (business_profile), never another tenant's deals or replies.
 */
export function historyOnly(p: Profile | null, keep: (jobId: string) => boolean, opts: { exact?: boolean } = {}): Profile | null {
  if (!p) return null;
  const history = p.history.filter((h) => keep(h.job_id));
  // `exact` (another workspace may have contributed): the brain keeps only its newest history rows, so
  // even a profile whose remaining rows are all kept may carry menu, area or reply speed learned from
  // evicted rows of another tenant. Always rebuilt from the kept rows (S5-D F15).
  if (history.length === p.history.length && !opts.exact) return p;
  if (!history.length) return null;
  const quotes = history.filter((h) => h.kind === "quote");
  const perUnits = quotes.map((h) => h.per_unit_usd).filter((n): n is number => n !== undefined);
  const typical = median(perUnits);
  // Fields the brain accumulated from replies without per-row provenance (menu, minimums, deposit and
  // discount habits, flags) can't be told apart from seed text, so a mixed profile drops them: unknown,
  // never sample. Channels are recomputed from the real rows.
  const { per_unit_usd: _p, menu: _m, minimum_order_usd: _mo, minimum_quantity: _mq, deposit_pct: _d, discount_pct: _dp, discount_needs_competing_quote: _dn, flags_seen: _f, ...kept } = p;
  // Exact: the area (the first request's) and reply speed came from rows that may not be kept either.
  const { area: _a, median_reply_minutes: _r, ...exact } = kept;
  const rest = opts.exact ? exact : kept;
  const channels = [...new Set(history.map((h) => h.channel))];
  const counts = new Map<string, number>();
  for (const h of quotes) counts.set(h.channel, (counts.get(h.channel) ?? 0) + 1);
  return {
    ...rest, menu: [], flags_seen: [], channels_seen: channels,
    best_channel: ([...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? channels[0] ?? p.best_channel) as Profile["best_channel"],
    history, n_quotes: quotes.length,
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
