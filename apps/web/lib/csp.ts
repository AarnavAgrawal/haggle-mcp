// The Content-Security-Policy, built per request by proxy.ts with a fresh nonce. Pure, no imports, so
// tests (tests/hardening.test.ts) and the proxy share it.
//
// Scripts: 'self' 'nonce-<n>' 'strict-dynamic', never 'unsafe-inline'. Next reads the nonce from the
// request's content-security-policy header and puts it on its own scripts; 'strict-dynamic' lets those
// scripts load further scripts (chunks, Turnstile's api.js). Every page renders per request (the root
// layout awaits connection()), so no prerendered page ships nonce-less inline scripts.
//
// Styles: 'self' 'unsafe-inline', no nonce, a deliberate trade-off. The app uses React style={{…}}
// attributes, and a nonce in style-src would make browsers ignore 'unsafe-inline' and drop them. Script
// injection is the XSS risk that matters; injected CSS can't run code under this policy.
//
// No upgrade-insecure-requests: HSTS covers https sites, and it would break `next start` over plain http.

export interface CspEnv {
  /** Per-request nonce (base64). Without one, script-src is 'self' only (no inline script runs). */
  nonce?: string;
  supabaseUrl?: string;
  turnstileSiteKey?: string;
  dev?: boolean;
}

const TURNSTILE = "https://challenges.cloudflare.com";

/** A nonce that can sit inside 'nonce-…' and that Next's extractor accepts: base64/base64url, bounded. */
export function isValidNonce(nonce: string): boolean {
  return /^[A-Za-z0-9+/_-]{16,128}={0,2}$/.test(nonce);
}

/** 16 bytes from the platform CSPRNG, base64 (24 characters). */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/** The policy: self, plus Supabase (https + wss) and, when its key is set, Turnstile. */
export function buildCsp(env: CspEnv): string {
  if (env.nonce !== undefined && !isValidNonce(env.nonce)) throw new Error("buildCsp: invalid nonce");
  let supabase: string[] = [];
  try {
    if (env.supabaseUrl?.trim()) {
      const u = new URL(env.supabaseUrl.trim());
      supabase = [u.origin, `${u.protocol === "http:" ? "ws:" : "wss:"}//${u.host}`];
    }
  } catch { /* a malformed URL adds nothing; the app fails loudly elsewhere (lib/env.ts) */ }
  const turnstile = env.turnstileSiteKey?.trim() ? [TURNSTILE] : [];
  // With 'strict-dynamic', CSP3 browsers ignore 'self' and host sources; they stay for older browsers.
  const scripts = env.nonce ? ["'self'", `'nonce-${env.nonce}'`, "'strict-dynamic'"] : ["'self'"];
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", [...scripts, ...(env.dev ? ["'unsafe-eval'"] : []), ...turnstile]],
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
