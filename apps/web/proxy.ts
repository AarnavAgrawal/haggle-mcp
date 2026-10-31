// Refreshes the Supabase session on every request and sends signed-out visitors to /login. An
// optimistic check only: pages and route handlers still verify the user (lib/workspace.ts).
//
// Also the one Content-Security-Policy (lib/csp.ts): a fresh nonce per request, set on the request
// headers (Next reads the nonce from the request's content-security-policy and puts it on its scripts;
// x-nonce is for the app's own headers().get) and on every response this returns, redirects included.
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, newNonce } from "./lib/csp";

// /api/* answers for itself (401/403 JSON from each route), never with a redirect to a page.
const PUBLIC = [/^\/$/, /^\/login(?:\/|$)/, /^\/auth\//, /^\/api\//, /^\/(?:terms|privacy|acceptable-use)(?:\/|$)/];

/** Continue to the app with the policy and nonce on the request; reads the request's current cookies. */
function forward(request: NextRequest, csp: string, nonce: string): NextResponse {
  const headers = new Headers(request.headers);
  headers.set("content-security-policy", csp);
  headers.set("x-nonce", nonce);
  return NextResponse.next({ request: { headers } });
}

export async function proxy(request: NextRequest) {
  const nonce = newNonce();
  const csp = buildCsp({
    nonce,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    turnstileSiteKey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
    dev: process.env.NODE_ENV === "development",
  });
  let response = forward(request, csp, nonce);
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        // Rebuilt after the cookie writes, so the page sees the refreshed session and the same nonce.
        response = forward(request, csp, nonce);
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });
  // getClaims() refreshes an expired session (the setAll above) and verifies the JWT locally against the
  // project's signing keys: no Auth round trip on every navigation. Pages re-check (lib/workspace.ts).
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims?.sub && !PUBLIC.some((p) => p.test(request.nextUrl.pathname))) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    const redirect = NextResponse.redirect(url);
    redirect.headers.set("content-security-policy", csp);
    return redirect;
  }
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|ico|webp)$).*)"],
};
