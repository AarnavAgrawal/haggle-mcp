import { NextResponse, type NextRequest } from "next/server";
import { finishSignIn } from "@/lib/auth/callback";
import { supabaseServer } from "@/lib/supabase/server";

/** The magic link / OAuth return: start the session, then go home (which routes on). */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const signedIn = await finishSignIn(url.searchParams, (await supabaseServer()).auth);
  return NextResponse.redirect(new URL(signedIn ? "/" : "/login?error=sign_in_failed", url.origin));
}
