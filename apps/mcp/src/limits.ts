// Request size and rate limits for the HTTP surface (sprint 4, workstream F). Registered once, before
// the auth middleware in index.ts, so an oversized body is refused before anything parses it:
//   * MCP requests (POST /mcp, /c/<secret>/mcp): at most HAGGLE_MCP_MAX_BODY_BYTES (default 256 KiB);
//   * Inkbox webhooks (POST /webhooks/inkbox): at most HAGGLE_WEBHOOK_MAX_BODY_BYTES (default 2 MiB).
//     A refused delivery isn't lost: the inbound reconciler lists the mailbox and ingests it;
//   * MCP tool calls: a token bucket per presented credential (a workspace's bearer token or
//     connector secret, so in practice per workspace; unauthenticated requests share one bucket):
//     HAGGLE_RATE_TOOL_CALLS_PER_MIN (default 120 in live mode, off in mock demos; 0 = off) refilled continuously, bursts up to
//     HAGGLE_RATE_TOOL_CALLS_BURST (default 30). Over it the call gets an MCP tool error with a fix
//     and Retry-After, not a dropped connection.
// Counters are in memory, per process (acceptable for the pilot's single instance; with N replicas a
// workspace gets up to N times the rate). Webhook 5xx answers are alerted (deduped by the alerter).
import { createHash } from "node:crypto";
import { getRuntime } from "./runtime.ts";
import { CONNECTOR_HEADER, SERVICE_TOKEN_HEADER, SERVICE_WORKSPACE_HEADER } from "./workspace.ts";

export interface LimitConfig {
  mcpMaxBytes: number;
  webhookMaxBytes: number;
  /** 0 = no tool-call rate limit. */
  toolCallsPerMinute: number;
  burst: number;
}

const int = (v: string | undefined, d: number, min: number, max: number) => {
  const n = v?.trim() ? Number(v) : d;
  return Number.isInteger(n) && n >= min && n <= max ? n : d;
};

/** Reads the limits from the environment (an invalid value falls back to its default). */
export function limitsFromEnv(env: Record<string, string | undefined>): LimitConfig {
  return {
    mcpMaxBytes: int(env.HAGGLE_MCP_MAX_BODY_BYTES, 256 * 1024, 1024, 16 * 1024 * 1024),
    webhookMaxBytes: int(env.HAGGLE_WEBHOOK_MAX_BODY_BYTES, 2 * 1024 * 1024, 1024, 32 * 1024 * 1024),
    toolCallsPerMinute: int(env.HAGGLE_RATE_TOOL_CALLS_PER_MIN, env.HAGGLE_MODE === "live" ? 120 : 0, 0, 100_000),
    burst: int(env.HAGGLE_RATE_TOOL_CALLS_BURST, 30, 1, 10_000),
  };
}

/** A token bucket per key (continuous refill). Bounded: the oldest keys are dropped past maxKeys. */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly perMs: number;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly maxKeys: number;
  constructor(perMinute: number, burst: number, now: () => number = Date.now, maxKeys = 10_000) {
    this.perMs = perMinute / 60_000;
    this.burst = burst;
    this.now = now;
    this.maxKeys = maxKeys;
  }
  take(key: string, n = 1): { ok: true; left: number } | { ok: false; retryAfterMs: number } {
    const t = this.now();
    const cur = this.buckets.get(key) ?? { tokens: this.burst, at: t };
    const tokens = Math.min(this.burst, cur.tokens + (t - cur.at) * this.perMs);
    this.buckets.delete(key);
    if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
    if (tokens < n) {
      this.buckets.set(key, { tokens, at: t });
      return { ok: false, retryAfterMs: Math.ceil((n - tokens) / this.perMs) };
    }
    this.buckets.set(key, { tokens: tokens - n, at: t });
    return { ok: true, left: Math.floor(tokens - n) };
  }
}

/** The JSON-RPC tool calls in an MCP request body (a single message or a batch). */
export function toolCalls(body: unknown): { count: number; id: string | number | null } {
  const msgs = Array.isArray(body) ? body : [body];
  const calls = msgs.filter((m) => m && typeof m === "object" && (m as { method?: unknown }).method === "tools/call");
  const id = !Array.isArray(body) && calls.length === 1 ? ((calls[0] as { id?: string | number }).id ?? null) : null;
  return { count: calls.length, id };
}

/** Bytes in a request body: Content-Length when given, otherwise counted from a clone, stopping past `cap`. */
export async function bodySize(req: Request, cap: number): Promise<number> {
  const declared = req.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared)) return Number(declared);
  const reader = req.clone().body?.getReader();
  if (!reader) return 0;
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > cap) {
      void reader.cancel().catch(() => {}); // not awaited: a cancelled tee branch settles only when both branches do
      break;
    }
  }
  return n;
}

/** The slice of a Hono context the middleware uses (no framework import; tests pass a fake). */
export interface LimitContext {
  req: { path: string; method: string; raw: Request; header(name: string): string | undefined };
  res: Response;
  json(body: unknown, status?: number, headers?: Record<string, string>): Response;
}

export interface LimitsOptions {
  basePath: string;
  webhookPath?: string;
  config?: LimitConfig;
  now?: () => number;
  /** A webhook answered 5xx (default: the live runtime's alerter, deduped per status). */
  onWebhookFailure?: (status: number, path: string) => void;
}

export const credentialKey = (c: LimitContext) => {
  // The web app's service token acts for many workspaces: one bucket per workspace it names.
  const service = c.req.header(SERVICE_TOKEN_HEADER);
  const cred = (service ? `${service}\n${c.req.header(SERVICE_WORKSPACE_HEADER) ?? ""}` : null)
    ?? c.req.header("authorization") ?? c.req.header(CONNECTOR_HEADER) ?? (c.req.path.match(/^\/c\/([^/]+)\/mcp$/)?.[1] ?? "");
  return cred ? createHash("sha256").update(cred).digest("hex").slice(0, 32) : "anonymous";
};

const defaultWebhookAlert = (status: number, path: string) => {
  void getRuntime().then((rt) => rt.ops?.alerts?.alert({ key: `webhook_failed:${status}`, severity: "warn", summary: `Inkbox webhook deliveries are failing (HTTP ${status}); the reconciler recovers them`, details: { status, path } })).catch(() => undefined);
};

/** The middleware: `server.use("*", limitsMiddleware({ basePath: server.basePath }))`, before the auth middleware. */
export function limitsMiddleware(o: LimitsOptions) {
  const cfg = o.config ?? limitsFromEnv(process.env);
  const bucket = cfg.toolCallsPerMinute > 0 ? new TokenBucket(cfg.toolCallsPerMinute, cfg.burst, o.now) : null;
  const webhookPath = o.webhookPath ?? "/webhooks/inkbox";
  const onWebhookFailure = o.onWebhookFailure ?? defaultWebhookAlert;
  return async (c: LimitContext, next: () => Promise<void>): Promise<Response | void> => {
    const path = c.req.path;
    const isMcp = path === o.basePath || /^\/c\/[^/]+\/mcp$/.test(path);
    const isWebhook = path === webhookPath;
    if ((isMcp || isWebhook) && c.req.method === "POST") {
      const cap = isWebhook ? cfg.webhookMaxBytes : cfg.mcpMaxBytes;
      if ((await bodySize(c.req.raw, cap)) > cap) {
        return c.json({ error: { code: "REQUEST_TOO_LARGE", message: `Request body is over the ${Math.round(cap / 1024)} KiB limit for this endpoint.`, fix: isWebhook ? "Nothing to do for Inkbox: the inbound reconciler lists the mailbox and ingests this item." : "Send less in one call: shorter request text and details, or split the work into several calls." } }, 413);
      }
      if (bucket && path === o.basePath) {
        const body: unknown = await c.req.raw.clone().json().catch(() => null);
        const calls = toolCalls(body);
        if (calls.count > 0) {
          const r = bucket.take(credentialKey(c), calls.count);
          if (!r.ok) {
            const s = Math.max(1, Math.ceil(r.retryAfterMs / 1000));
            const err = { ok: false, error: { code: "RATE_LIMITED", message: `Too many tool calls for this workspace (limit ${cfg.toolCallsPerMinute} per minute, bursts of ${cfg.burst}).`, fix: `Wait ${s} s, then retry. Poll with wait_for_update (it long-polls up to 60 s) instead of calling get_quotes in a loop.` }, next: "wait_for_update" };
            // One tool call: an MCP tool error the model reads. Otherwise a plain 429.
            return calls.id !== null
              ? c.json({ jsonrpc: "2.0", id: calls.id, result: { isError: true, content: [{ type: "text", text: JSON.stringify(err) }] } }, 200, { "Retry-After": String(s) })
              : c.json(err, 429, { "Retry-After": String(s) });
          }
        }
      }
    }
    await next();
    if (isWebhook && c.res.status >= 500) onWebhookFailure(c.res.status, path);
  };
}
