// Production hardening, pure and offline: the security headers (next.config.ts), guest gating
// (lib/account/gate.ts), the account routes' same-origin check and rate limit, and /api/health's report.
import { describe, expect, it } from "vitest";
import { buildCsp, securityHeaders } from "../next.config.ts";
import { GUEST_REFUSED_PATH, isAllowedUser } from "../lib/account/gate.ts";
import { healthReport, REQUIRED_ENV } from "../lib/account/health.ts";
import { Limiter, sameOrigin } from "../lib/account/request.ts";

const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? null;

describe("Content-Security-Policy", () => {
  it("is self-only with Supabase (https + wss) and the fixed protections", () => {
    const csp = buildCsp({ supabaseUrl: "https://abc.supabase.co" });
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
    expect(directive(csp, "connect-src")).toBe("connect-src 'self' https://abc.supabase.co wss://abc.supabase.co");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'self'");
    expect(directive(csp, "frame-src")).toBe("frame-src 'none'");
    expect(csp).not.toContain("challenges.cloudflare.com");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("allows Turnstile's script and frame only when its site key is set", () => {
    const csp = buildCsp({ supabaseUrl: "https://abc.supabase.co", turnstileSiteKey: "0x4AAA" });
    expect(directive(csp, "script-src")).toContain("https://challenges.cloudflare.com");
    expect(directive(csp, "frame-src")).toBe("frame-src https://challenges.cloudflare.com");
    expect(directive(csp, "connect-src")).not.toContain("cloudflare");
  });

  it("adds unsafe-eval and the HMR socket in development only; survives a missing or malformed Supabase URL", () => {
    expect(directive(buildCsp({ dev: true }), "script-src")).toContain("'unsafe-eval'");
    expect(directive(buildCsp({ dev: true }), "connect-src")).toBe("connect-src 'self' ws:");
    expect(directive(buildCsp({ supabaseUrl: "not a url" }), "connect-src")).toBe("connect-src 'self'");
    expect(directive(buildCsp({ supabaseUrl: "http://127.0.0.1:54321" }), "connect-src")).toBe("connect-src 'self' http://127.0.0.1:54321 ws://127.0.0.1:54321");
  });

  it("ships HSTS, nosniff, the referrer policy and a Permissions-Policy with camera, mic and location off", () => {
    const h = Object.fromEntries(securityHeaders({}).map((x) => [x.key, x.value]));
    expect(h["Strict-Transport-Security"]).toMatch(/^max-age=\d{8,}/);
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    for (const f of ["camera=()", "microphone=()", "geolocation=()"]) expect(h["Permissions-Policy"]).toContain(f);
    expect(h["Content-Security-Policy"]).toBeTruthy();
  });
});

describe("guest gating", () => {
  it("lets guests in only on a demo site; signed-in users always", () => {
    expect(isAllowedUser({ is_anonymous: true }, true)).toBe(true);
    expect(isAllowedUser({ is_anonymous: true }, false)).toBe(false);
    expect(isAllowedUser({ is_anonymous: false }, false)).toBe(true);
    expect(isAllowedUser({}, false)).toBe(true);
    expect(GUEST_REFUSED_PATH).toBe("/login?guest=off");
  });
});

describe("account route guards", () => {
  const req = (headers: Record<string, string>) => new Request("http://web.test/api/account/delete", { method: "POST", headers });
  it("accepts only this site's origin", () => {
    expect(sameOrigin(req({ origin: "http://web.test", host: "web.test" }))).toBe(true);
    expect(sameOrigin(req({ origin: "https://app.example", host: "internal:3200", "x-forwarded-host": "app.example" }))).toBe(true);
    expect(sameOrigin(req({ origin: "https://evil.example", host: "web.test" }))).toBe(false);
    expect(sameOrigin(req({ origin: "null", host: "web.test" }))).toBe(false);
    expect(sameOrigin(req({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(sameOrigin(req({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(sameOrigin(req({}))).toBe(false);
  });

  it("rate-limits per user in a sliding window", () => {
    let t = 0;
    const l = new Limiter(2, 1000, () => t);
    expect([l.take("a"), l.take("a"), l.take("a"), l.take("b")]).toEqual([true, true, false, true]);
    t = 1001;
    expect(l.take("a")).toBe(true);
  });
});

describe("/api/health report", () => {
  const fullEnv = Object.fromEntries(REQUIRED_ENV.map((k) => [k, "set"])) as Record<string, string>;
  it("names set and missing variables, never values, and reports the MCP server", async () => {
    const env = { ...fullEnv, SUPABASE_SERVICE_ROLE_KEY: "", ANTHROPIC_API_KEY: "sk-secret", HAGGLE_MCP_URL: "http://mcp.internal:3000/" };
    let url = "";
    const r = await healthReport({ env, demo: false, fetchImpl: (async (u: string) => { url = u; return Response.json({ ok: true, mode: "live" }); }) as typeof fetch });
    expect(url).toBe("http://mcp.internal:3000/health");
    expect(r.ok).toBe(false); // a required variable is missing
    expect(r.config.required_missing).toEqual(["SUPABASE_SERVICE_ROLE_KEY"]);
    expect(r.config.optional_set).toEqual(["HAGGLE_MCP_URL", "ANTHROPIC_API_KEY"]);
    expect(r.mcp).toEqual({ reachable: true, status: 200, mode: "live", mode_matches_site: true });
    expect(JSON.stringify(r)).not.toMatch(/sk-secret|mcp\.internal/);
  });

  it("is ok when configured and reachable; flags a demo site facing a live server; times out after the limit", async () => {
    const ok = await healthReport({ env: fullEnv, demo: true, fetchImpl: (async () => Response.json({ mode: "live" })) as typeof fetch });
    expect(ok.ok).toBe(true);
    expect(ok.mcp.mode_matches_site).toBe(false);
    const hang = ((_u: string, init?: RequestInit) => new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    const slow = await healthReport({ env: fullEnv, demo: false, fetchImpl: hang, timeoutMs: 20 });
    expect(slow).toMatchObject({ ok: false, mcp: { reachable: false, error: "timed out after 2 s" } });
    const down = await healthReport({ env: fullEnv, demo: false, fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    expect(down.mcp).toEqual({ reachable: false, error: "unreachable" });
  });
});
