// Who is calling a tool, and what they may touch (public mode, AUTH_MODE=oauth).
//
// Token mode has one operator (the shared MCP_AUTH_TOKEN): userId is null and
// the operator owns every job with no owner. OAuth mode has many users, each
// identified by their verified Supabase sign-in; a user sees only their own jobs.
import type { JobRow } from "./db/queries.js";

export interface Caller {
  /** Supabase user id in oauth mode; null for the token-mode operator. */
  userId: string | null;
  /** Verified sign-in email in oauth mode (the approver); null in token mode. */
  email: string | null;
}

export const OPERATOR: Caller = { userId: null, email: null };

/**
 * Read the verified identity mcp-use attaches to the request as `ctx.auth`.
 * In oauth mode a missing identity is an error, never a fallback to the
 * operator: that would hand a signed-out request every owner-less job.
 */
export function callerFromContext(ctx: unknown, mode: "token" | "oauth"): Caller {
  if (mode === "token") return OPERATOR;
  const user = (ctx as { auth?: { user?: { id?: unknown; email?: unknown } } } | undefined)?.auth?.user;
  if (typeof user?.id !== "string" || user.id.length === 0) {
    throw new Error("oauth mode: request has no verified user");
  }
  return { userId: user.id, email: typeof user.email === "string" ? user.email.trim().toLowerCase() : null };
}

/** A job is visible only to its owner (the operator owns owner-less jobs). */
export function canAccess(job: Pick<JobRow, "owner_id">, caller: Caller): boolean {
  return (job.owner_id ?? null) === caller.userId;
}

/**
 * client_request_id is unique across the whole table, so scope it per user.
 * Otherwise one user could reuse another's id and get their job back.
 */
export function scopedClientRequestId(caller: Caller, id: string): string {
  return caller.userId ? `${caller.userId}:${id}` : id;
}
