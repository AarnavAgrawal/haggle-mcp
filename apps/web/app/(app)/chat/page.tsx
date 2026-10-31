import { Chat, type RecentThread } from "@/components/chat/Chat";
import { ago } from "@/lib/dashboard/format";
import { listThreads } from "@/lib/chat/store";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { requireHaggle } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/** How many earlier conversations the new-request page lists (the shell rail lists the deals). */
const RECENT = 5;

/** A new conversation: Haggle gathers the requirements, previews who it will contact, then starts the deal. */
export default async function NewChatPage() {
  const { user, workspaceId } = await requireHaggle();
  const threads = await listThreads(supabaseAdmin(), { userId: user.id, workspaceId }, RECENT).catch(() => []);
  const now = new Date();
  const recent: RecentThread[] = threads.map((t) => ({ id: t.id, title: t.title || "Conversation", when: ago(t.updated_at, now), deal: !!t.job_id }));
  return <Chat threadId={null} initial={[]} recent={recent} />;
}
