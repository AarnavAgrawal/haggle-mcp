import { TopBar } from "@/components/TopBar";
import { Chat } from "@/components/chat/Chat";
import { ThreadSidebar, type ThreadSummary } from "@/components/chat/ThreadSidebar";
import { listThreads } from "@/lib/chat/store";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { requireHaggle } from "@/lib/workspace";
import "./chat.css";

export const dynamic = "force-dynamic";

/** A new conversation: Haggle gathers the requirements, previews who it will contact, then starts the deal. */
export default async function NewChatPage() {
  const { user, workspaceId } = await requireHaggle();
  const threads: ThreadSummary[] = await listThreads(supabaseAdmin(), { userId: user.id, workspaceId }).catch(() => []);
  return (
    <>
      <TopBar email={user.email} active="chat" />
      <div className="chat-layout">
        <ThreadSidebar threads={threads} />
        <Chat threadId={null} initial={[]} />
      </div>
    </>
  );
}
