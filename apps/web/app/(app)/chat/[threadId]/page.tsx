import { notFound } from "next/navigation";
import { Chat } from "@/components/chat/Chat";
import { toDisplay } from "@/lib/chat/history";
import { loadMessages } from "@/lib/chat/store";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { requireHaggle } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/** Resume a conversation (only the signed-in user's own, in their workspace). */
export default async function ThreadPage({ params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  const { user, workspaceId } = await requireHaggle();
  const loaded = await loadMessages(supabaseAdmin(), threadId, { userId: user.id, workspaceId });
  if (!loaded) notFound();
  return <Chat key={loaded.thread.id} threadId={loaded.thread.id} title={loaded.thread.title} initial={toDisplay(loaded.messages, loaded.thread.job_id)} />;
}
