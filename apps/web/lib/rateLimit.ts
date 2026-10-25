// Rate limits for the web app's routes. Pure: the database client is injected (lib/limiters.ts wires
// the real, server-only one), so this is testable without Next or Supabase.
//   memoryLimiter   fixed windows aligned to the epoch (86 400 s = the UTC day), in this process only.
//   durableLimiter  the same windows in the shared database: take_rate_slot (migration 124) through
//                   supabase.rpc as service_role, so every server instance counts together. When the
//                   database can't answer (an error, no client, a malformed or slow answer) it falls back
//                   to its own memory limiter for that process (logged once per outage) and asks again
//                   after `retryMs`: a database hiccup never refuses a user (fail open, not closed).

export type Take = { ok: true } | { ok: false; retryAfterS: number };
export interface Limiter { take(key: string): Promise<Take> }

/** Never refuses (a limit switched off). */
export const unlimited: Limiter = { take: async () => ({ ok: true }) };

/**
 * At most `max` takes per key per fixed `windowMs` window. Bounded: past 10 000 keys, finished windows
 * are dropped (then not again until the map doubles, so a sweep costs O(1) per take); past 50 000 live
 * keys, all are (it fails open rather than grow).
 */
export function memoryLimiter(max: number, windowMs: number, opts: { now?: () => number } = {}): Limiter & { size(): number } {
  const now = opts.now ?? Date.now;
  const hits = new Map<string, { start: number; n: number }>();
  let sweepAt = 10_000;
  return {
    size: () => hits.size,
    async take(key: string): Promise<Take> {
      const t = now();
      const start = Math.floor(t / windowMs) * windowMs;
      if (hits.size > sweepAt) {
        for (const [k, v] of hits) if (v.start !== start) hits.delete(k);
        if (hits.size > 50_000) hits.clear();
        sweepAt = Math.max(10_000, hits.size * 2);
      }
      const h = hits.get(key);
      const n = h && h.start === start ? h.n : 0;
      if (n >= max) return { ok: false, retryAfterS: Math.max(1, Math.ceil((start + windowMs - t) / 1000)) };
      hits.set(key, { start, n: n + 1 });
      return { ok: true };
    },
  };
}

/** The slice of a supabase-js client the durable limiter uses. */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export interface DurableOptions {
  now?: () => number;
  /** How long to use the memory limiter after a failure before asking the database again (default 30 s). */
  retryMs?: number;
  /** How long one take may wait for the database (default 2 s). */
  timeoutMs?: number;
  /** Where the fallback is reported (default: one JSON line on stderr). Never given the key or a secret. */
  log?: (event: string, data: Record<string, unknown>) => void;
}

const defaultLog = (event: string, data: Record<string, unknown>) => console.warn(JSON.stringify({ level: "warn", event, ...data }));

/**
 * `max` takes per key per `windowS` (1..86 400) window, shared by every server instance through
 * take_rate_slot. `client` is called lazily, at the first take, so building a limiter never needs the
 * service-role key; it runs only on the server.
 */
export function durableLimiter(bucket: string, max: number, windowS: number, client: () => RpcClient, opts: DurableOptions = {}): Limiter {
  const now = opts.now ?? Date.now;
  const retryMs = opts.retryMs ?? 30_000;
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const log = opts.log ?? defaultLog;
  const memory = memoryLimiter(max, windowS * 1000, { now });
  let downUntil = 0;
  let warned = false;

  async function ask(key: string): Promise<Take> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`take_rate_slot took over ${timeoutMs} ms`)), timeoutMs); });
    try {
      const { data, error } = await Promise.race([Promise.resolve(client().rpc("take_rate_slot", { p_bucket: bucket, p_key: key, p_window_s: windowS, p_max: max })), timeout]);
      if (error) throw new Error(error.message);
      const row = (Array.isArray(data) ? data[0] : data) as { allowed?: unknown; retry_after_s?: unknown } | null | undefined;
      if (!row || typeof row.allowed !== "boolean") throw new Error("take_rate_slot gave an unexpected answer");
      if (row.allowed) return { ok: true };
      const s = Math.ceil(Number(row.retry_after_s));
      return { ok: false, retryAfterS: Number.isFinite(s) && s >= 1 ? s : 1 };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async take(key: string): Promise<Take> {
      if (now() < downUntil) return memory.take(key);
      try {
        const r = await ask(key);
        warned = false;
        return r;
      } catch (e) {
        downUntil = now() + retryMs;
        if (!warned) log("rate_limit_fallback", { bucket, error: String((e as Error)?.message ?? e).slice(0, 200), next: "apply supabase/migrations/124_engine_rate_limits.sql and check SUPABASE_URL / the service-role key; this instance limits in memory meanwhile" });
        warned = true;
        return memory.take(key);
      }
    },
  };
}
