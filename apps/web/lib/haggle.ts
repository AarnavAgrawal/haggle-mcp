// The web app's client for the Haggle MCP server, used only on this app's server (it holds the
// service token). Every deal action goes through the MCP endpoint, as the workspace the signed-in
// user belongs to: x-haggle-service-token + x-haggle-workspace (apps/mcp/src/workspace.ts).
//
// Tool results keep `_meta` apart (`meta`): it can carry a one-time approval code meant only for
// a human's click. Never pass `meta` to the LLM or the browser.

const PROTOCOL = "2025-06-18";

/** A refusal from the server, with the server's own fix and next step (CLAUDE.md §6). */
export class HaggleError extends Error {
  constructor(readonly code: string, message: string, readonly fix: string, readonly next: string | null = null, readonly status?: number) {
    super(message);
    this.name = "HaggleError";
  }
}

export interface HaggleConfig {
  baseUrl: string;
  serviceToken: string;
  fetchImpl?: typeof fetch;
}

export interface ToolResult<T> {
  /** structuredContent: what the tool's outputSchema (and the dashboard) describe. */
  data: T;
  /** The short model-facing summary. */
  text: string;
  /** Server-only side channel (approval tickets). Never forwarded. */
  meta?: Record<string, unknown>;
}

const base = (cfg: HaggleConfig) => cfg.baseUrl.replace(/\/+$/, "");

/** An HTTP refusal (401 unknown credentials, 404 disabled, 5xx) as a HaggleError. */
async function httpError(res: Response): Promise<HaggleError> {
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string; fix?: string } | string };
  const e = typeof body.error === "object" ? body.error : { message: body.error };
  return new HaggleError(e?.code ?? `HTTP_${res.status}`, e?.message ?? `The Haggle server answered ${res.status}.`, e?.fix ?? "Check HAGGLE_MCP_URL and HAGGLE_SERVICE_TOKEN.", null, res.status);
}

/** A JSON-RPC answer, plain JSON or one server-sent event (Streamable HTTP). */
export function parseRpcBody(text: string): { result?: unknown; error?: { code: number; message: string } } {
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : text);
}

/** A tool's isError content ({ ok: false, error: { code, message, fix }, next }) as a HaggleError. */
export function toolError(text: string): HaggleError {
  try {
    const e = JSON.parse(text) as { error?: { code?: string; message?: string; fix?: string }; next?: string };
    if (e.error) return new HaggleError(e.error.code ?? "TOOL_ERROR", e.error.message ?? text, e.error.fix ?? "", e.next ?? null);
  } catch { /* not the envelope: plain text */ }
  return new HaggleError("TOOL_ERROR", text, "");
}

export function haggleClient(cfg: HaggleConfig, workspaceId: string) {
  const f = cfg.fetchImpl ?? fetch;
  let id = 0;
  async function rpc<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await f(`${base(cfg)}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL,
        "x-haggle-service-token": cfg.serviceToken, "x-haggle-workspace": workspaceId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw await httpError(res);
    const msg = parseRpcBody(await res.text());
    if (msg.error) throw new HaggleError("RPC_ERROR", msg.error.message, "Check the tool name and its arguments.");
    return msg.result as T;
  }
  return {
    workspaceId,
    async listTools(): Promise<{ name: string; description?: string; inputSchema: Record<string, unknown> }[]> {
      return (await rpc<{ tools: { name: string; description?: string; inputSchema: Record<string, unknown> }[] }>("tools/list", {})).tools;
    },
    async callTool<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<ToolResult<T>> {
      const r = await rpc<{ isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: T; _meta?: Record<string, unknown> }>("tools/call", { name, arguments: args }, signal);
      const text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
      if (r.isError) throw toolError(text);
      return { data: (r.structuredContent ?? {}) as T, text, ...(r._meta ? { meta: r._meta } : {}) };
    },
    /** As a trusted MCP Apps host (the board/card button tools). See callToolAsHost below. */
    callToolAsHost<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<ToolResult<T>> {
      return callToolAsHost<T>(cfg, workspaceId, name, args, signal);
    },
  };
}
export type HaggleClient = ReturnType<typeof haggleClient>;

/** POST /internal/workspaces: the signed-up user's workspace, created once per owner. */
export async function provisionWorkspace(
  cfg: HaggleConfig,
  body: { owner_ref: string; name?: string; approver_phone?: string; approver_email?: string; cap_usd?: number; timezone?: string; area?: string },
): Promise<{ workspace_id: string; created: boolean }> {
  const res = await (cfg.fetchImpl ?? fetch)(`${base(cfg)}/internal/workspaces`, {
    method: "POST", headers: { "content-type": "application/json", "x-haggle-service-token": cfg.serviceToken }, body: JSON.stringify(body), cache: "no-store",
  });
  if (!res.ok) throw await httpError(res);
  return (await res.json()) as { workspace_id: string; created: boolean };
}

// ── Host calls (approval, payment, callbacks) ──────────────────────────────────────────────────
// The board/card button tools (choose_in_view, approve_in_view, call_back_in_view) run only for a
// client that declares the MCP Apps UI extension in the per-request envelope (protocol 2026-07-28,
// apps/mcp/index.ts rendersViews). This web app's server IS such a host: it renders its own approval
// panel, keeps the one-time ticket in `meta` on the server, and spends it only on the human's click.

const HOST_PROTOCOL = "2026-07-28";
const UI_EXTENSION = { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } };
let hostId = 0;

/** tools/call with the host envelope and the same service headers; same { data, text, meta } as callTool. */
export async function callToolAsHost<T = Record<string, unknown>>(
  cfg: HaggleConfig, workspaceId: string, name: string, args: Record<string, unknown> = {}, signal?: AbortSignal,
): Promise<ToolResult<T>> {
  const res = await (cfg.fetchImpl ?? fetch)(`${base(cfg)}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": HOST_PROTOCOL, "mcp-method": "tools/call", "mcp-name": name,
      "x-haggle-service-token": cfg.serviceToken, "x-haggle-workspace": workspaceId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: ++hostId, method: "tools/call",
      params: {
        name, arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": HOST_PROTOCOL,
          "io.modelcontextprotocol/clientInfo": { name: "haggle-web", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": { extensions: UI_EXTENSION },
        },
      },
    }),
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw await httpError(res);
  const msg = parseRpcBody(await res.text());
  if (msg.error) throw new HaggleError("RPC_ERROR", msg.error.message, "Check the tool name and its arguments.");
  const r = msg.result as { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: T; _meta?: Record<string, unknown> };
  const text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
  if (r.isError) throw toolError(text);
  return { data: (r.structuredContent ?? {}) as T, text, ...(r._meta ? { meta: r._meta } : {}) };
}
