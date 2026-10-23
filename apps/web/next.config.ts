import type { NextConfig } from "next";

// Security headers for every response. The builders are pure and exported for tests
// (tests/hardening.test.ts); they live here because next.config.ts can't reliably import local TS files.
//
// CSP without nonces: Next's inline bootstrap scripts and React's inline styles need 'unsafe-inline'.
// Nonces would need proxy.ts to mint one per request and every page to render dynamically; until then
// frame-ancestors/object-src/base-uri/form-action and the connect-src allowlist carry the protection.
// No upgrade-insecure-requests: HSTS covers https sites, and it would break `next start` over plain http.

export interface CspEnv {
  supabaseUrl?: string;
  turnstileSiteKey?: string;
  dev?: boolean;
}

const TURNSTILE = "https://challenges.cloudflare.com";

/** The Content-Security-Policy value: self, plus Supabase (https + wss) and, when its key is set, Turnstile. */
export function buildCsp(env: CspEnv): string {
  let supabase: string[] = [];
  try {
    if (env.supabaseUrl?.trim()) {
      const u = new URL(env.supabaseUrl.trim());
      supabase = [u.origin, `${u.protocol === "http:" ? "ws:" : "wss:"}//${u.host}`];
    }
  } catch { /* a malformed URL adds nothing; the app fails loudly elsewhere (lib/env.ts) */ }
  const turnstile = env.turnstileSiteKey?.trim() ? [TURNSTILE] : [];
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", "'unsafe-inline'", ...(env.dev ? ["'unsafe-eval'"] : []), ...turnstile]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", ["'self'", ...supabase, ...(env.dev ? ["ws:"] : [])]],
    ["frame-src", turnstile.length ? turnstile : ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
  ];
  return directives.map(([k, v]) => [k, ...v].join(" ")).join("; ");
}

/** Every security header, CSP included. */
export function securityHeaders(env: CspEnv): { key: string; value: string }[] {
  return [
    { key: "Content-Security-Policy", value: buildCsp(env) },
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  ];
}

const config: NextConfig = {
  // The shared view schemas and contracts are TypeScript sources in the monorepo.
  transpilePackages: ["@haggle/core"],
  // Type checking runs in `npm run typecheck` (TypeScript 7, the repo's compiler); next build's own
  // checker needs the JavaScript TypeScript API, which TypeScript 7 doesn't ship.
  typescript: { ignoreBuildErrors: true },
  // NEXT_OUTPUT=standalone: a self-contained server in .next/standalone for a container host.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),
  poweredByHeader: false,
  async headers() {
    const env: CspEnv = {
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      turnstileSiteKey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
      dev: process.env.NODE_ENV === "development",
    };
    return [{ source: "/(.*)", headers: securityHeaders(env) }];
  },
};

export default config;
