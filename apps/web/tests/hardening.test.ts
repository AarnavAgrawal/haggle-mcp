// Production hardening, pure and offline: the security headers (lib/csp.ts, next.config.ts), guest gating
// (lib/account/gate.ts), the account routes' same-origin check and rate limit, and /api/health's report.
import { describe, expect, it } from "vitest";
import { buildCsp, isValidNonce } from "../lib/csp.ts";
import { securityHeaders } from "../next.config.ts";
import { GUEST_REFUSED_PATH, isAllowedUser } from "../lib/account/gate.ts";
import { healthReport, REQUIRED_ENV } from "../lib/account/health.ts";
import { sameOrigin } from "../lib/account/request.ts";
import { memoryLimiter } from "../lib/rateLimit.ts";

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
    const h = Object.fromEntries(securityHeaders().map((x) => [x.key, x.value]));
    expect(h["Strict-Transport-Security"]).toMatch(/^max-age=\d{8,}/);
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    for (const f of ["camera=()", "microphone=()", "geolocation=()"]) expect(h["Permissions-Policy"]).toContain(f);
    expect(h["X-Frame-Options"]).toBe("DENY");
  });

  it("is not a static header: proxy.ts sends the one per-request policy, so a response never carries two", () => {
    const keys = securityHeaders().map((x) => x.key.toLowerCase());
    expect(keys).not.toContain("content-security-policy");
    expect(keys).not.toContain("content-security-policy-report-only");
  });

  it("with a nonce: scripts need the nonce ('strict-dynamic'), never 'unsafe-inline'; styles keep inline", () => {
    const nonce = "MTIzNDU2Nzg5MGFiY2RlZg==";
    const csp = buildCsp({ supabaseUrl: "https://abc.supabase.co", nonce });
    expect(directive(csp, "script-src")).toBe(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(directive(csp, "style-src")).toBe("style-src 'self' 'unsafe-inline'");
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    // Next reads the nonce from the request's policy with this pattern (get-script-nonce-from-header.js).
    const src = directive(csp, "script-src")!.split(" ").slice(1).find((s) => /^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/.test(s));
    expect(src).toBe(`'nonce-${nonce}'`);
  });

  it("with a nonce in development adds only 'unsafe-eval'; Turnstile's host stays for browsers without strict-dynamic", () => {
    expect(directive(buildCsp({ nonce: "abcdefgh12345678", dev: true }), "script-src")).toBe("script-src 'self' 'nonce-abcdefgh12345678' 'strict-dynamic' 'unsafe-eval'");
    const ts = buildCsp({ nonce: "abcdefgh12345678", turnstileSiteKey: "0x4AAA" });
    expect(directive(ts, "script-src")).toBe("script-src 'self' 'nonce-abcdefgh12345678' 'strict-dynamic' https://challenges.cloudflare.com");
    expect(directive(ts, "frame-src")).toBe("frame-src https://challenges.cloudflare.com");
  });

  it("never allows inline scripts, with or without a nonce, in any mode", () => {
    for (const nonce of [undefined, "abcdefgh12345678"]) {
      for (const dev of [false, true]) {
        expect(directive(buildCsp({ nonce, dev, turnstileSiteKey: "0x4AAA" }), "script-src")).not.toContain("'unsafe-inline'");
      }
    }
    expect(directive(buildCsp({}), "script-src")).toBe("script-src 'self'");
  });

  it("refuses a nonce that could break out of the header or the source expression", () => {
    for (const bad of ["", "a b", "a;b", "a'b", "a\r\nb", "a,b", "x".repeat(200)]) {
      expect(isValidNonce(bad), JSON.stringify(bad)).toBe(false);
      expect(() => buildCsp({ nonce: bad })).toThrow(/nonce/);
    }
    expect(isValidNonce("MTIzNDU2Nzg5MGFiY2RlZg==")).toBe(true);
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

  it("rate-limits per user in a fixed window", async () => {
    let t = 0;
    const l = memoryLimiter(2, 1000, { now: () => t });
    const ok = async (k: string) => (await l.take(k)).ok;
    expect([await ok("a"), await ok("a"), await ok("a"), await ok("b")]).toEqual([true, true, false, true]);
    t = 1001;
    expect(await ok("a")).toBe(true);
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
