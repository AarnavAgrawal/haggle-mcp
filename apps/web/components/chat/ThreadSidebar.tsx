import Link from "next/link";

export interface ThreadSummary {
  id: string;
  title: string | null;
  job_id: string | null;
  updated_at: string;
}

/** Recent conversations, newest first, plus a link to start a new one. */
export function ThreadSidebar({ threads, activeId }: { threads: ThreadSummary[]; activeId?: string }) {
  return (
    <aside className="chat-side" aria-label="Conversations">
      <div className="side-body">
        <Link className="btn btn-block" href="/chat">
          New request
        </Link>
        <h2>Recent</h2>
        {threads.length ? (
          <ul className="thread-list">
            {threads.map((t) => (
              <li key={t.id}>
                <Link href={`/chat/${t.id}`} aria-current={t.id === activeId ? "page" : undefined} title={t.title ?? "Conversation"}>
                  {t.title || "Conversation"}
                  {t.job_id && <span className="thread-deal">Deal started</span>}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="chat-side-empty">Your conversations show up here.</p>
        )}
      </div>
    </aside>
  );
}
