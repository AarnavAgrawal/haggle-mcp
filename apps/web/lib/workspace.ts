// Who is signed in and which Haggle workspace they act in. The web app checks membership here;
// the MCP server then trusts the service token's x-haggle-workspace (apps/mcp/src/workspace.ts).
//
// Speed: every lookup is wrapped in React cache(), so the (app) layout, the page and any component in
// one request share a single session check, membership query and (auto-)onboarding. The session check
// reads the JWT's claims with getClaims(), which verifies the token locally against the project's
// signing keys (no Auth round trip; with a symmetric key it falls back to the Auth server itself).
// Destructive or identity-critical actions (account deletion, data export) use verifiedSessionUser(),
// which always asks the Auth server (getUser) so a revoked session can't act.
import { cache } from "react";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { haggleConfig } from "@/lib/env";
import { autoOnboard } from "@/lib/demo";
import { haggleClient, provisionWorkspace } from "@/lib/haggle";
import { GUEST_REFUSED_PATH, isAllowedUser } from "@/lib/account/gate";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";

export { isAllowedUser };

/** The signed-in user as pages and API routes need them (from the verified JWT claims). */
export interface SessionUser {
  id: string;
  /** The sign-in email; undefined for a guest (anonymous sign-in). */
  email?: string;
  is_anonymous?: boolean;
}

/** The Supabase session's user from the verified JWT claims, guests included (gating is sessionUser's job). */
const rawSessionUser = cache(async (): Promise<SessionUser | null> => {
  const { data } = await (await supabaseServer()).auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) return null;
  return { id: claims.sub, email: claims.email || undefined, is_anonymous: claims.is_anonymous === true };
});

/**
 * The signed-in user every page and API route acts for, or null. A guest (anonymous sign-in) counts
 * only on a demo site (isAllowedUser): on a live site their routes answer 401 and pages go to /login.
 */
export const sessionUser = cache(async (): Promise<SessionUser | null> => {
  const user = await rawSessionUser();
  return user && isAllowedUser(user) ? user : null;
});

/**
 * Like sessionUser, but confirmed by the Auth server (getUser, a network round trip) and returning the
 * full Supabase user. For account deletion and data export, where a revoked session must not act.
 */
export async function verifiedSessionUser(): Promise<User | null> {
  const { data } = await (await supabaseServer()).auth.getUser();
  const user = data.user ?? null;
  return user && isAllowedUser(user) ? user : null;
}

/** The user's workspace (row-level security: a user reads only their own memberships). One query per request. */
export const membership = cache(async (userId: string): Promise<{ workspace_id: string; role: string } | null> => {
  const { data, error } = await (await supabaseServer()).from("workspace_members").select("workspace_id, role").eq("user_id", userId).order("created_at").limit(1).maybeSingle();
  if (error) throw new Error(`workspace lookup failed: ${error.message}`);
  return data;
});

/**
 * The signed-in user's Haggle client; sends them to /login or /onboarding when there is none yet.
 * Cached per request: the (app) layout and the page share one result (and one auto-onboarding).
 */
export const requireHaggle = cache(async () => {
  const user = await rawSessionUser();
  if (!user) redirect("/login");
  if (!isAllowedUser(user)) redirect(GUEST_REFUSED_PATH); // a guest on a live site: sign in with an email
  const m = await membership(user.id);
  if (!m) {
    // Guests, and everyone on a demo site, get their workspace without the onboarding form.
    if (!autoOnboard(user)) redirect("/onboarding");
    const workspaceId = await onboard(user, { name: user.is_anonymous ? "Guest workspace" : "Demo workspace" });
    return { user, workspaceId, haggle: haggleClient(haggleConfig(), workspaceId) };
  }
  return { user, workspaceId: m.workspace_id, haggle: haggleClient(haggleConfig(), m.workspace_id) };
});

/** Onboarding: the MCP server creates the workspace (once per user); this app records the membership. */
export async function onboard(user: SessionUser, input: { name: string; approverPhone?: string; capUsd?: number; area?: string }): Promise<string> {
  const r = await provisionWorkspace(haggleConfig(), {
    owner_ref: user.id, name: input.name, ...(user.email ? { approver_email: user.email } : {}),
    ...(input.approverPhone ? { approver_phone: input.approverPhone } : {}), ...(input.capUsd ? { cap_usd: input.capUsd } : {}), ...(input.area ? { area: input.area } : {}),
  });
  const { error } = await supabaseAdmin().from("workspace_members").upsert({ user_id: user.id, workspace_id: r.workspace_id, role: "owner" }, { onConflict: "user_id,workspace_id" });
  if (error) throw new Error(`couldn't record the workspace membership: ${error.message}`);
  return r.workspace_id;
}
