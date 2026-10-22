import { createClient } from "@supabase/supabase-js";
import { supabaseConfig, supabaseServiceRoleKey } from "@/lib/env";

/**
 * Server only: the service-role client bypasses row-level security. Used for the one write a user
 * can't make themselves (attaching their account to the workspace onboarding created).
 */
export const supabaseAdmin = () => createClient(supabaseConfig().url, supabaseServiceRoleKey(), { auth: { persistSession: false, autoRefreshToken: false } });
