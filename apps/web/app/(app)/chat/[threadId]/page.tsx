import { notFound } from "next/navigation";
import { Chat } from "@/components/chat/Chat";
import { ThreadSidebar, type ThreadSummary } from "@/components/chat/ThreadSidebar";
import { toDisplay } from "@/lib/chat/history";
import { listThreads, loadMessages } from "@/lib/chat/store";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { requireHaggle } from "@/lib/workspace";
import "../chat.css";

export const dynamic = "force-dynamic";

/** Resume a conversation (only the signed-in user's own, in their workspace). */
export default async function ThreadPage({ params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  const { user, workspaceId } = await requireHaggle();
  const owner = { userId: user.id, workspaceId };
  const db = supabaseAdmin();
  const [loaded, threads] = await Promise.all([loadMessages(db, threadId, owner), listThreads(db, owner).catch((): ThreadSummary[] => [])]);
  if (!loaded) notFound();
  return (
    <>
      <div className="chat-layout">
        <ThreadSidebar threads={threads} activeId={loaded.thread.id} />
        <Chat key={loaded.thread.id} threadId={loaded.thread.id} initial={toDisplay(loaded.messages, loaded.thread.job_id)} />
      </div>
    </>
  );
}
