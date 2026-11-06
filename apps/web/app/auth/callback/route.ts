import { NextResponse, type NextRequest } from "next/server";
import { refusedNewAccount } from "@/lib/auth/callback";
import { supabaseServer } from "@/lib/supabase/server";

/** The OAuth and PKCE return: exchange the code for a session, then go home (which routes on). Someone new goes to the waitlist. */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  if (refusedNewAccount(url.searchParams)) return NextResponse.redirect(new URL("/waitlist", url.origin));
  const code = url.searchParams.get("code");
  if (code) {
    const { error } = await (await supabaseServer()).auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL("/", url.origin));
  }
  return NextResponse.redirect(new URL("/login?error=sign_in_failed", url.origin));
}
