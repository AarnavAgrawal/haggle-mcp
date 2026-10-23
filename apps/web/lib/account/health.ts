// GET /api/health: is the web app configured, and can it reach the MCP server? Variable NAMES only,
// never values, and never the MCP URL. The MCP /health fetch gives up after 2 s.

/** Without these the app can't sign anyone in or reach Haggle. */
export const REQUIRED_ENV = ["HAGGLE_SERVICE_TOKEN", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const;
/** Features degrade without these (chat, bot protection, support contact, MCP URL defaults to localhost). */
export const OPTIONAL_ENV = ["HAGGLE_MCP_URL", "ANTHROPIC_API_KEY", "NEXT_PUBLIC_TURNSTILE_SITE_KEY", "NEXT_PUBLIC_SUPPORT_EMAIL", "WEB_CHAT_DAILY_CAP"] as const;

export interface HealthReport {
  ok: boolean;
  demo: boolean;
  /** mode_matches_site: a demo site should face a mock server, a live site a live one (informational: local dev runs live-site code against mock). */
  mcp: { reachable: boolean; status?: number; mode?: string; mode_matches_site?: boolean; error?: string };
  config: { required_set: string[]; required_missing: string[]; optional_set: string[] };
}

const isSet = (env: Record<string, string | undefined>, k: string) => !!env[k]?.trim();

export async function healthReport(opts: { env: Record<string, string | undefined>; demo: boolean; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<HealthReport> {
  const { env } = opts;
  const config = {
    required_set: REQUIRED_ENV.filter((k) => isSet(env, k)),
    required_missing: REQUIRED_ENV.filter((k) => !isSet(env, k)),
    optional_set: OPTIONAL_ENV.filter((k) => isSet(env, k)),
  };
  const base = (env.HAGGLE_MCP_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");
  let mcp: HealthReport["mcp"];
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${base}/health`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 2000), cache: "no-store" });
    const body = (await res.json().catch(() => ({}))) as { mode?: unknown };
    mcp = { reachable: res.ok, status: res.status, ...(typeof body.mode === "string" ? { mode: body.mode, mode_matches_site: body.mode === (opts.demo ? "mock" : "live") } : {}) };
  } catch (err) {
    mcp = { reachable: false, error: err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "timed out after 2 s" : "unreachable" };
  }
  return { ok: mcp.reachable && config.required_missing.length === 0, demo: opts.demo, mcp, config };
}
