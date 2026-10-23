// Small guards for the account API routes: same-origin (a destructive cookie-authenticated POST must come
// from this site's own page, not a cross-site form) and a per-user rate limit. Pure; no Next imports.

/** True when the browser says the request came from this site (Origin, else Sec-Fetch-Site). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
    try {
      return new URL(origin).host === host.split(",")[0]!.trim();
    } catch {
      return false;
    }
  }
  return req.headers.get("sec-fetch-site") === "same-origin";
}

/** At most `max` calls per key per `windowMs` (in memory, per server instance). */
export class Limiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number, private now: () => number = Date.now) {}
  take(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}

export const accountJson = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
export const accountError = (status: number, code: string, message: string, fix: string) => accountJson(status, { ok: false, error: { code, message, fix } });
