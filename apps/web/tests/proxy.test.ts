// proxy.ts: a fresh CSP nonce per request, handed to Next on the request headers (Next reads the nonce
// from the request's content-security-policy) and sent on the response, on pass-through and redirects,
// including when Supabase refreshes the session and the response is rebuilt (the setAll callback).
// @supabase/ssr is replaced with a fake client: no network, no Supabase project.
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CookieWrite = { name: string; value: string; options?: Record<string, unknown> };
const fake = vi.hoisted(() => ({ user: null as { id: string } | null, refresh: [] as { name: string; value: string; options?: Record<string, unknown> }[] }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, opts: { cookies: { setAll: (l: CookieWrite[]) => void } }) => ({
    auth: {
      getUser: async () => {
        if (fake.refresh.length) opts.cookies.setAll(fake.refresh);
        return { data: { user: fake.user }, error: null };
      },
    },
  }),
}));

const { proxy } = await import("../proxy.ts");

const NONCE_RE = /'nonce-([A-Za-z0-9+/_-]+={0,2})'/;
const nonceOf = (csp: string | null) => csp?.match(NONCE_RE)?.[1] ?? null;
// NextResponse.next({ request: { headers } }) forwards each overridden request header as x-middleware-request-<name>.
const forwarded = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);
const req = (path: string, cookie?: string) => new NextRequest(`http://web.test${path}`, { headers: cookie ? { cookie } : {} });

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ci-placeholder.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "ci-placeholder-anon-key");
  vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
  fake.user = null;
  fake.refresh = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("proxy CSP nonce", () => {
  it("passes a public page through with one nonce on the response and the forwarded request policy", async () => {
    const res = await proxy(req("/terms"));
    expect(res.headers.get("location")).toBeNull();
    const csp = res.headers.get("content-security-policy");
    const nonce = nonceOf(csp);
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/); // 16 random bytes, base64
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(forwarded(res, "content-security-policy")).toBe(csp);
    expect(forwarded(res, "x-nonce")).toBe(nonce);
    expect(res.headers.get("x-middleware-override-headers")).toContain("content-security-policy");
    expect(res.headers.get("x-nonce")).toBeNull(); // the nonce goes to the app, not out as its own header
  });

  it("mints a different nonce for every request", async () => {
    const seen = new Set<string | null>();
    for (let i = 0; i < 20; i++) seen.add(nonceOf((await proxy(req("/"))).headers.get("content-security-policy")));
    expect(seen.size).toBe(20);
    expect(seen.has(null)).toBe(false);
  });

  it("sends a CSP on the redirect of a signed-out visitor to /login", async () => {
    const res = await proxy(req("/chat"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    expect(nonceOf(res.headers.get("content-security-policy"))).toBeTruthy();
  });

  it("keeps the nonce when Supabase refreshes the session and the response is rebuilt", async () => {
    fake.user = { id: "u1" };
    fake.refresh = [{ name: "sb-access", value: "fresh", options: { path: "/" } }];
    const res = await proxy(req("/chat", "sb-access=stale"));
    expect(res.headers.get("location")).toBeNull();
    const csp = res.headers.get("content-security-policy");
    const nonce = nonceOf(csp);
    expect(nonce).toBeTruthy();
    expect(forwarded(res, "content-security-policy")).toBe(csp);
    expect(forwarded(res, "x-nonce")).toBe(nonce);
    // The rebuilt response forwards the refreshed cookie to the page and sets it on the browser.
    expect(forwarded(res, "cookie")).toContain("sb-access=fresh");
    expect(res.headers.get("set-cookie")).toContain("sb-access=fresh");
  });

  it("allows Turnstile's host when its site key is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "0x4AAA");
    const csp = (await proxy(req("/login"))).headers.get("content-security-policy")!;
    expect(csp).toContain("frame-src https://challenges.cloudflare.com");
    expect(csp).toMatch(/script-src [^;]*'strict-dynamic' https:\/\/challenges\.cloudflare\.com/);
  });
});
