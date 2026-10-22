// Who is signed in and which Haggle workspace they act in. The web app checks membership here;
// the MCP server then trusts the service token's x-haggle-workspace (apps/mcp/src/workspace.ts).
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { haggleConfig } from "@/lib/env";
import { haggleClient, provisionWorkspace } from "@/lib/haggle";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";

export async function sessionUser(): Promise<User | null> {
  const { data } = await (await supabaseServer()).auth.getUser();
  return data.user ?? null;
}

/** The user's workspace (row-level security: a user reads only their own memberships). */
export async function membership(userId: string): Promise<{ workspace_id: string; role: string } | null> {
  const { data, error } = await (await supabaseServer()).from("workspace_members").select("workspace_id, role").eq("user_id", userId).order("created_at").limit(1).maybeSingle();
  if (error) throw new Error(`workspace lookup failed: ${error.message}`);
  return data;
}

/** The signed-in user's Haggle client; sends them to /login or /onboarding when there is none yet. */
export async function requireHaggle() {
  const user = await sessionUser();
  if (!user) redirect("/login");
  const m = await membership(user.id);
  if (!m) redirect("/onboarding");
  return { user, workspaceId: m.workspace_id, haggle: haggleClient(haggleConfig(), m.workspace_id) };
}

/** Onboarding: the MCP server creates the workspace (once per user); this app records the membership. */
export async function onboard(user: User, input: { name: string; approverPhone?: string; capUsd?: number; area?: string }): Promise<string> {
  const r = await provisionWorkspace(haggleConfig(), {
    owner_ref: user.id, name: input.name, ...(user.email ? { approver_email: user.email } : {}),
    ...(input.approverPhone ? { approver_phone: input.approverPhone } : {}), ...(input.capUsd ? { cap_usd: input.capUsd } : {}), ...(input.area ? { area: input.area } : {}),
  });
  const { error } = await supabaseAdmin().from("workspace_members").upsert({ user_id: user.id, workspace_id: r.workspace_id, role: "owner" }, { onConflict: "user_id,workspace_id" });
  if (error) throw new Error(`couldn't record the workspace membership: ${error.message}`);
  return r.workspace_id;
}
