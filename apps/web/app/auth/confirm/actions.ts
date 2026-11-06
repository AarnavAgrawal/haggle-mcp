"use server";

import { redirect } from "next/navigation";
import { confirmEmailLink } from "@/lib/auth/callback";
import { supabaseServer } from "@/lib/supabase/server";

/** The button on /auth/confirm: start the session, then go home (which routes on). */
export async function finishEmailSignIn(form: FormData) {
  const signedIn = await confirmEmailLink({ token_hash: form.get("token_hash"), type: form.get("type") }, (await supabaseServer()).auth);
  redirect(signedIn ? "/" : "/login?error=sign_in_failed");
}
