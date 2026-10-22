import { createBrowserClient } from "@supabase/ssr";

/** Supabase in the browser (sign-in only). NEXT_PUBLIC_ values are inlined at build time. */
export const supabaseBrowser = () => createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
