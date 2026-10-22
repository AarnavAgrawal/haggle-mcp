// Web app configuration, read on the server only. A missing value fails loudly, naming what to set.

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set (see .env.example, "Web app")`);
  return v;
}

/** The Haggle MCP server and the service token it shares with this app (HAGGLE_SERVICE_TOKEN on both). */
export const haggleConfig = () => ({ baseUrl: process.env.HAGGLE_MCP_URL?.trim() || "http://localhost:3000", serviceToken: need("HAGGLE_SERVICE_TOKEN") });

/** Supabase Auth (the public URL and anon key are also inlined into the browser bundle). */
export const supabaseConfig = () => ({ url: need("NEXT_PUBLIC_SUPABASE_URL"), anonKey: need("NEXT_PUBLIC_SUPABASE_ANON_KEY") });

/** Server only: bypasses row-level security (the one write users can't make: their membership). */
export const supabaseServiceRoleKey = () => need("SUPABASE_SERVICE_ROLE_KEY");
