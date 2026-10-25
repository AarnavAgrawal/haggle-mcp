import type { NextConfig } from "next";

// Static security headers for every response. The builder is pure and exported for tests
// (tests/hardening.test.ts); it lives here because next.config.ts can't reliably import local TS files.
//
// No Content-Security-Policy here: proxy.ts sends it per request with a fresh script nonce (lib/csp.ts),
// and a second, static policy would be enforced alongside it. Static assets the proxy skips
// (_next/static, images) need no policy.

/** HSTS, nosniff, frame denial, referrer policy and Permissions-Policy (the CSP comes from proxy.ts). */
export function securityHeaders(): { key: string; value: string }[] {
  return [
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
    return [{ source: "/(.*)", headers: securityHeaders() }];
  },
};

export default config;
