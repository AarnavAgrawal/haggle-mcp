// The user's Terms acceptance (supabase/migrations/302_web_profiles.sql), written with the service role at
// onboarding. Server only.
import { supabaseAdmin } from "@/lib/supabase/admin";
import { TERMS_VERSION } from "./legal.ts";

export async function recordTermsAcceptance(userId: string, at = new Date()): Promise<void> {
  const { error } = await supabaseAdmin().from("web_profiles").upsert({ user_id: userId, accepted_terms_at: at.toISOString(), terms_version: TERMS_VERSION }, { onConflict: "user_id" });
  if (error) throw new Error(`couldn't record your acceptance of the Terms: ${error.message}`);
}
