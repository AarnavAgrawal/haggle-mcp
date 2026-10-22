import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseConfig } from "@/lib/env";

/** Supabase as the signed-in user (server components, route handlers, server actions). */
export async function supabaseServer() {
  const store = await cookies();
  const { url, anonKey } = supabaseConfig();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // A server component can't set cookies; proxy.ts refreshes the session on the next request.
        }
      },
    },
  });
}
