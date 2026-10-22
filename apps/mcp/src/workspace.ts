// Tenancy for the MCP endpoint (ported from haggle-testing src/comms/auth + workspace.ts). A
// connection is bound to one workspace by `Authorization: Bearer <token>`, or by the secret in a
// connector URL (/c/<secret>/mcp, for Claude/ChatGPT custom connectors that can't set headers).
// Only SHA-256 hashes are stored. Kept free of the HTTP framework so it can be unit tested.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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

/** Headers carrying the web app's service credential and the workspace it acts for. */
export const SERVICE_TOKEN_HEADER = "x-haggle-service-token";
export const SERVICE_WORKSPACE_HEADER = "x-haggle-workspace";

/**
 * The web app's server-to-server credential (HAGGLE_SERVICE_TOKEN, at least 32 chars; unset = off).
 * Fixed-length digests: timingSafeEqual throws on unequal byte lengths (a non-ASCII token).
 */
export function serviceTokenValid(given: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const secret = env.HAGGLE_SERVICE_TOKEN?.trim() ?? "";
  if (secret.length < 32 || !given) return false;
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(given), digest(secret));
}

export async function resolveWorkspace(rt: Runtime, headers: { authorization?: string | null; connectorSecret?: string | null; serviceToken?: string | null; workspaceId?: string | null }, required = authRequired(), env: NodeJS.ProcessEnv = process.env): Promise<WorkspaceResolution> {
  // The web app acts for the workspace its signed-in user belongs to (it checks membership); only
  // with the service token, only an existing, unrevoked workspace.
  if (headers.serviceToken) {
    if (!serviceTokenValid(headers.serviceToken, env)) return { ok: false, reason: "unknown_credentials" };
    const id = headers.workspaceId?.trim();
    if (!id) return { ok: false, reason: "missing_credentials" };
    const ws = await rt.engine.workspaceById(id);
    return ws && !ws.revoked_at ? { ok: true, workspaceId: ws.id, authenticated: true } : { ok: false, reason: "unknown_credentials" };
  }
  const token = bearerToken(headers.authorization);
  const secret = headers.connectorSecret?.trim() || null;
  if (token || secret) {
    const ws = token ? await rt.engine.workspaceByCredential("token", hashSecret(token)) : await rt.engine.workspaceByCredential("connector_secret", hashSecret(secret!));
    return ws ? { ok: true, workspaceId: ws.id, authenticated: true } : { ok: false, reason: "unknown_credentials" };
  }
  return required ? { ok: false, reason: "missing_credentials" } : { ok: true, workspaceId: DEFAULT_WORKSPACE_ID, authenticated: false };
}

/**
 * A workspace for a web app user (POST /internal/workspaces). The id is derived from the owner's
 * account id, so a retried signup finds the same workspace; its bearer token and connector secret
 * are random and never shown (the web app reaches it with the service credential).
 */
export function planServiceWorkspace(a: { ownerRef: string; name: string; approverPhone?: string; approverEmail?: string; capUsd?: number; timezone?: string; area?: string }) {
  if (!a.ownerRef?.trim()) throw new Error("ownerRef is required");
  if (a.approverPhone && !/^\+[1-9]\d{6,14}$/.test(a.approverPhone)) throw new Error("approver phone must be E.164, e.g. +14155550123");
  if (a.capUsd !== undefined && !(a.capUsd > 0)) throw new Error("the spending cap must be positive");
  return {
    id: `ws_u_${hashSecret(`haggle-web:${a.ownerRef}`).slice(0, 24)}`,
    name: (a.name?.trim() || "My workspace").slice(0, 120),
    tokenHash: hashSecret(newSecret("hgw")), connectorSecretHash: hashSecret(newSecret("hgc")),
    timezone: a.timezone ?? "America/Los_Angeles",
    settings: {
      spending_cap_cents: Math.round((a.capUsd ?? 1500) * 100), approver_phone: a.approverPhone ?? null,
      approver_email: a.approverEmail?.toLowerCase() ?? null, default_area: a.area ?? null,
    },
  };
}

/** JSON-RPC methods allowed without credentials: the handshake hosting health checks perform. */
const OPEN_METHODS = new Set(["initialize", "notifications/initialized", "ping"]);

/** True when every JSON-RPC message in a POST body is part of the handshake (single or batch). */
export function isHandshakeOnly(method: string, body: unknown): boolean {
  if (method !== "POST") return false;
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.length > 0 && msgs.every((m) => !!m && typeof (m as { method?: unknown }).method === "string" && OPEN_METHODS.has((m as { method: string }).method));
}
