// Supabase client using the service-role key (server-side only; never exposed).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getConfig } from "../config.js";

let client: SupabaseClient | undefined;

export function db(): SupabaseClient {
  if (!client) {
    const cfg = getConfig();
    client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/** Throw on a Supabase error so callers don't silently continue with null data. */
export function must<T>(res: { data: T; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) throw new DbError(`${what}: ${res.error.message}`, res.error.code);
  return res.data;
}

export class DbError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
  }
}

/** Postgres unique_violation. */
export const UNIQUE_VIOLATION = "23505";
