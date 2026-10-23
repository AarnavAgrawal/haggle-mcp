// The real dependencies of account export and deletion: Supabase (service role, every query filtered to
// the signed-in user), the MCP server (list_deals / get_quotes as the user's workspace, and the
// service route POST /internal/account/revoke). Server only.
import type { User } from "@supabase/supabase-js";
import { haggleConfig } from "@/lib/env";
import { callService, haggleClient } from "@/lib/haggle";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";
import type { DeleteDeps, RevokeResult } from "./delete.ts";
import { EXPORT_DEALS_LIMIT, type ExportDeps } from "./export.ts";

/** The user's membership; null before onboarding (nothing on the MCP server to export or revoke). */
type Member = { workspace_id: string; role: string } | null;

const check = (what: string) => ({ error }: { error: { message: string } | null }) => {
  if (error) throw new Error(`${what}: ${error.message}`);
};

export function exportDeps(user: User, m: Member): ExportDeps {
  const db = supabaseAdmin();
  const haggle = m ? haggleClient(haggleConfig(), m.workspace_id) : null;
  return {
    user: { id: user.id, email: user.email ?? null, created_at: user.created_at },
    workspaceId: m?.workspace_id ?? null,
    async loadThreads() {
      const { data, error } = await db.from("chat_threads").select("id, title, job_id, created_at, updated_at").eq("user_id", user.id).order("created_at");
      if (error) throw new Error(`couldn't read your chats: ${error.message}`);
      return data ?? [];
    },
    async loadMessages(threadIds) {
      const { data, error } = await db.from("chat_messages").select("thread_id, role, content, created_at").in("thread_id", threadIds).order("id");
      if (error) throw new Error(`couldn't read your chat messages: ${error.message}`);
      return data ?? [];
    },
    async listDeals() {
      return haggle ? ((await haggle.callTool<{ deals: { job_id: string }[] }>("list_deals", { limit: EXPORT_DEALS_LIMIT })).data.deals ?? []) : [];
    },
    async getQuotes(jobId) {
      if (!haggle) throw new Error("No workspace.");
      return (await haggle.callTool<Record<string, unknown>>("get_quotes", { job_id: jobId })).data; // data only: never meta
    },
  };
}

export function deleteDeps(user: User, m: Member): DeleteDeps {
  const db = supabaseAdmin();
  return {
    role: m?.role ?? "none",
    revoke: async () => {
      if (!m) return { cancelled: [], not_cancelled: [] };
      return callService<RevokeResult>(haggleConfig(), "/internal/account/revoke", { workspaceId: m.workspace_id, actor: user.id, body: { confirm: true } });
    },
    deleteThreads: async () => check("couldn't delete your chats")(await db.from("chat_threads").delete().eq("user_id", user.id)),
    deleteMemberships: async () => check("couldn't remove your workspace membership")(await db.from("workspace_members").delete().eq("user_id", user.id)),
    deleteProfile: async () => check("couldn't delete your profile")(await db.from("web_profiles").delete().eq("user_id", user.id)),
    deleteAuthUser: async () => check("couldn't delete your sign-in")(await db.auth.admin.deleteUser(user.id)),
    signOut: async () => {
      await (await supabaseServer()).auth.signOut();
    },
  };
}
