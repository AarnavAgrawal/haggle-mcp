// Tenancy for the MCP endpoint (ported from haggle-testing src/comms/auth + workspace.ts). A
// connection is bound to one workspace by `Authorization: Bearer <token>`, or by the secret in a
// connector URL (/c/<secret>/mcp, for Claude/ChatGPT custom connectors that can't set headers).
// Only SHA-256 hashes are stored. Kept free of the HTTP framework so it can be unit tested.
import { createHash, randomBytes } from "node:crypto";
import { DEFAULT_WORKSPACE_ID } from "@haggle/engine";
import type { Runtime } from "./runtime.ts";

/** Header carrying a connector secret from /c/:secret/mcp to the MCP endpoint. */
export const CONNECTOR_HEADER = "x-haggle-connector-secret";

export const hashSecret = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** "hgw_..." bearer token / "hgc_..." connector secret: 24 random bytes, base64url. */
export const newSecret = (prefix: "hgw" | "hgc") => `${prefix}_${randomBytes(24).toString("base64url")}`;

export function bearerToken(authorization: string | undefined | null): string | null {
  const m = authorization?.match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1]! : null;
}

/**
 * Auth mode. Live mode always requires a workspace credential: real outreach and payments are
 * never reachable without one, whatever HAGGLE_AUTH says (fail closed). In mock mode (DEMO),
 * HAGGLE_AUTH=required turns it on; otherwise a request without credentials uses the default
 * workspace. A credential that doesn't match, or a revoked workspace's, is always refused.
 */
export function authRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HAGGLE_MODE === "live" || env.HAGGLE_AUTH === "required";
}

/**
 * Approval policy. Live mode: only out-of-band human answers approve (a coded text from the
 * workspace approver's phone; email too when the operator enables it). Mock mode keeps the card,
 * the client's form and the simulated human (DEMO) unless HAGGLE_APPROVALS=out_of_band.
 */
export function outOfBandApprovals(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HAGGLE_MODE === "live" || env.HAGGLE_APPROVALS === "out_of_band";
}

/**
 * Approval by an emailed APPROVE <code> from a mailbox Inkbox can't authenticate (Gmail and the
 * like) rests on a spoofable From address: off unless the operator sets HAGGLE_EMAIL_APPROVAL_BY_CODE=true.
 */
export function emailApprovalByCode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HAGGLE_EMAIL_APPROVAL_BY_CODE === "true";
}

export type WorkspaceResolution = { ok: true; workspaceId: string; authenticated: boolean } | { ok: false; reason: "missing_credentials" | "unknown_credentials" };

export async function resolveWorkspace(rt: Runtime, headers: { authorization?: string | null; connectorSecret?: string | null }, required = authRequired()): Promise<WorkspaceResolution> {
  const token = bearerToken(headers.authorization);
  const secret = headers.connectorSecret?.trim() || null;
  if (token || secret) {
    const ws = token ? await rt.engine.workspaceByCredential("token", hashSecret(token)) : await rt.engine.workspaceByCredential("connector_secret", hashSecret(secret!));
    return ws ? { ok: true, workspaceId: ws.id, authenticated: true } : { ok: false, reason: "unknown_credentials" };
  }
  return required ? { ok: false, reason: "missing_credentials" } : { ok: true, workspaceId: DEFAULT_WORKSPACE_ID, authenticated: false };
}

/** JSON-RPC methods allowed without credentials: the handshake hosting health checks perform. */
const OPEN_METHODS = new Set(["initialize", "notifications/initialized", "ping"]);

/** True when every JSON-RPC message in a POST body is part of the handshake (single or batch). */
export function isHandshakeOnly(method: string, body: unknown): boolean {
  if (method !== "POST") return false;
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.length > 0 && msgs.every((m) => !!m && typeof (m as { method?: unknown }).method === "string" && OPEN_METHODS.has((m as { method: string }).method));
}
