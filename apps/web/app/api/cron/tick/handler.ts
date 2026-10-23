// The background-tick backup (GET /api/cron/tick, called by Vercel Cron or any scheduler). With
// Authorization: Bearer <CRON_SECRET> it forwards one POST /internal/tick to the MCP server with
// HAGGLE_TICK_SECRET, which advances every open deal (deadlines, follow-ups, email -> call escalation),
// and returns the server's JSON. The live MCP server also ticks itself every 30 s: this is the backup.
// Refusals happen before any request; no response or log line carries either secret.
import { createHash, timingSafeEqual } from "node:crypto";

type Env = Record<string, string | undefined>;

export interface CronTickDeps {
  env: Env;
  fetchImpl?: typeof fetch;
  /** How long the MCP server may take to advance every open deal (the route's maxDuration is 60 s). */
  timeoutMs?: number;
}

const MIN_SECRET = 16;
const NO_STORE = { "cache-control": "no-store" };

const refuse = (status: number, code: string, message: string, fix: string) =>
  Response.json({ ok: false, error: { code, message, fix } }, { status, headers: NO_STORE });

// Fixed-length digests: timingSafeEqual throws on unequal lengths, and a non-ASCII token can match the
// secret's character count but not its byte count.
const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
const sameSecret = (given: string, secret: string) => given.length > 0 && timingSafeEqual(digest(given), digest(secret));

/** http only to this machine (local development); anything remote must be https, or the tick secret travels in clear. */
function mcpBase(raw: string | undefined): { ok: true; base: string } | { ok: false } {
  const value = raw?.trim() || "http://localhost:3000";
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return { ok: false };
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return { ok: false };
  return { ok: true, base: value.replace(/\/+$/, "") };
}

export async function handleCronTick(request: Request, deps: CronTickDeps): Promise<Response> {
  const cronSecret = deps.env.CRON_SECRET?.trim() ?? "";
  if (cronSecret.length < MIN_SECRET) {
    return refuse(404, "cron_disabled", "The cron endpoint is off.", `Set CRON_SECRET (at least ${MIN_SECRET} characters) on the web app; Vercel Cron sends it as the bearer automatically.`);
  }
  const given = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
  if (!sameSecret(given, cronSecret)) {
    return refuse(401, "unauthorized", "Missing or wrong cron credential.", "Send Authorization: Bearer <CRON_SECRET>.");
  }

  const tickSecret = deps.env.HAGGLE_TICK_SECRET?.trim() ?? "";
  if (tickSecret.length < MIN_SECRET) {
    return refuse(503, "tick_not_configured", "The web app has no tick secret.", `Set HAGGLE_TICK_SECRET (at least ${MIN_SECRET} characters) on the web app, the same value as on the MCP server.`);
  }
  const target = mcpBase(deps.env.HAGGLE_MCP_URL);
  if (!target.ok) {
    return refuse(503, "insecure_mcp_url", "HAGGLE_MCP_URL must be an https URL (http only for localhost).", "Set HAGGLE_MCP_URL to the MCP server's https base URL, without /mcp.");
  }

  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(`${target.base}/internal/tick`, {
      method: "POST",
      headers: { authorization: `Bearer ${tickSecret}`, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(deps.timeoutMs ?? 50_000),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    console.error(JSON.stringify({ event: "cron_tick_failed", reason: timedOut ? "timeout" : "unreachable" }));
    return timedOut
      ? refuse(504, "mcp_timeout", "The MCP server didn't finish the tick in time.", "Check the server's /ready and logs; the next run retries (the live server also ticks itself every 30 s).")
      : refuse(502, "mcp_unreachable", "Couldn't reach the MCP server.", "Check HAGGLE_MCP_URL and that the server is running (its /health).");
  }

  if (res.status === 401) return refuse(502, "tick_refused", "The MCP server refused the tick secret.", "HAGGLE_TICK_SECRET must be the same value on the web app and on the MCP server.");
  if (res.status === 404) return refuse(502, "tick_disabled", "The MCP server's /internal/tick is off (or HAGGLE_MCP_URL points elsewhere).", "Set HAGGLE_TICK_SECRET (at least 16 characters) on the MCP server and check HAGGLE_MCP_URL.");
  if (res.status === 503) return refuse(503, "mcp_not_ready", "The MCP server isn't configured or ready.", "Check the server's /ready for the configuration problem.");
  if (!res.ok) {
    console.error(JSON.stringify({ event: "cron_tick_failed", reason: "status", status: res.status }));
    return refuse(502, "mcp_error", `The MCP server answered ${res.status}.`, "Check the server's logs; the next run retries.");
  }
  const data = await res.json().catch(() => null);
  if (!data || typeof data !== "object") return refuse(502, "bad_response", "The MCP server's answer wasn't JSON.", "Check that HAGGLE_MCP_URL is the MCP server's base URL (without /mcp).");
  return Response.json(data, { status: 200, headers: NO_STORE });
}
