// A bounded wait for a database connection. postgres.js queues a query without limit when every
// pooled connection is busy, so under load (many boards polling wait_for_update, a slow or saturated
// Supabase pooler, the 2026-10 EMAXCONNSESSION incident) requests pile up with no deadline. The gate
// admits at most `max` queries/transactions at once (the pool size, so it never opens more than the
// pool would), queues at most `maxQueue` more, and fails a waiter after `queueTimeoutMs` with
// PoolBusyError, which isTransient() treats as retryable ("timed out"). Fragments (sql`now()` inside
// another query) are never awaited, so they pass through untouched; only execution is gated.

export class PoolBusyError extends Error {
  override name = "PoolBusyError";
  readonly code = "EPOOLBUSY";
  constructor(why: "queue_timeout" | "queue_full", ms: number) {
    super(why === "queue_full" ? "database pool busy: wait queue full (timed out immediately)" : `database pool busy: no connection free within ${ms} ms (timed out)`);
  }
}

export interface PoolStats {
  max: number;
  in_use: number;
  queued: number;
  peak_in_use: number;
  peak_queued: number;
  /** Waiters failed after queueTimeoutMs. */
  timeouts: number;
  /** Waiters refused because the queue was full. */
  rejected: number;
}

export class PoolGate {
  private inUse = 0;
  private readonly waiters: { grant: () => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private s = { peak_in_use: 0, peak_queued: 0, timeouts: 0, rejected: 0 };

  readonly max: number;
  readonly queueTimeoutMs: number;
  readonly maxQueue: number;

  // No parameter properties: the operator scripts load this under Node's type stripping.
  constructor(max: number, queueTimeoutMs = 5_000, maxQueue = 500) {
    if (!(Number.isInteger(max) && max >= 1)) throw new Error("pool max must be a positive integer");
    this.max = max;
    this.queueTimeoutMs = queueTimeoutMs;
    this.maxQueue = maxQueue;
  }

  /** Waits for a slot; resolves to its release function (call it exactly once). */
  acquire(): Promise<() => void> {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) { clearTimeout(next.timer); next.grant(); } // the slot passes straight to the next waiter
      else this.inUse--;
    };
    if (this.inUse < this.max) {
      this.inUse++;
      this.s.peak_in_use = Math.max(this.s.peak_in_use, this.inUse);
      return Promise.resolve(release);
    }
    if (this.waiters.length >= this.maxQueue) {
      this.s.rejected++;
      return Promise.reject(new PoolBusyError("queue_full", 0));
    }
    return new Promise((resolve, reject) => {
      const w = {
        grant: () => resolve(release),
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          this.s.timeouts++;
          reject(new PoolBusyError("queue_timeout", this.queueTimeoutMs));
        }, this.queueTimeoutMs),
      };
      (w.timer as { unref?: () => void }).unref?.();
      this.waiters.push(w);
      this.s.peak_queued = Math.max(this.s.peak_queued, this.waiters.length);
    });
  }

  async run<T>(f: () => PromiseLike<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await f();
    } finally {
      release();
    }
  }

  stats(): PoolStats {
    return { max: this.max, in_use: this.inUse, queued: this.waiters.length, ...this.s };
  }
}

const isTemplate = (a: unknown) => Array.isArray(a) && "raw" in (a as object);

/** A lazy query whose execution (then / catch / finally) waits for a gate slot; everything else is the query itself. */
function gatedQuery<Q extends object>(q: Q, gate: PoolGate): Q {
  const exec = () => gate.run(() => new Promise((res, rej) => (Reflect.get(q, "then") as (a: unknown, b: unknown) => unknown).call(q, res, rej)));
  const proxy: Q = new Proxy(q, {
    get(target, p) {
      if (p === "then") return (ok?: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => exec().then(ok, fail);
      if (p === "catch") return (fail?: (e: unknown) => unknown) => exec().then(undefined, fail);
      if (p === "finally") return (f?: () => void) => exec().finally(f);
      const v = Reflect.get(target, p, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return proxy;
}

/**
 * Wraps a postgres.js `sql` so every executed tagged-template query and every `begin` transaction
 * holds a gate slot while it runs. Helpers (sql(obj), sql.json, sql.end) and fragments pass through.
 */
export function gatedSql<S extends object>(sql: S, gate: PoolGate): S {
  return new Proxy(sql, {
    apply(target, thisArg, args: unknown[]) {
      const q = Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
      return isTemplate(args[0]) && q && typeof q === "object" ? gatedQuery(q as object, gate) : q;
    },
    get(target, p) {
      const v = Reflect.get(target, p, target);
      if (p === "begin" && typeof v === "function") return (...a: unknown[]) => gate.run(() => (v as (...x: unknown[]) => PromiseLike<unknown>).apply(target, a));
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
