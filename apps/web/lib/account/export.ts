// "Download my data": one JSON document generated on the server. The user's chat threads and messages
// (Supabase, filtered to this user) plus the workspace's deals as the MCP server reports
// them (list_deals, then get_quotes per deal). Only tool data goes in: never `_meta` (it can carry
// one-time approval codes). Deps are injected so it is testable without Supabase or a server.

export interface ExportDeps {
  user: { id: string; email: string | null; created_at?: string };
  workspaceId: string | null;
  loadThreads(): Promise<{ id: string; title: string | null; job_id: string | null; created_at: string; updated_at: string }[]>;
  loadMessages(threadIds: string[]): Promise<{ thread_id: string; role: string; content: unknown; created_at: string }[]>;
  listDeals(): Promise<{ job_id: string; [k: string]: unknown }[]>;
  getQuotes(jobId: string): Promise<Record<string, unknown>>;
  now?: () => Date;
}

export const EXPORT_DEALS_LIMIT = 20; // list_deals' maximum

export async function buildExport(d: ExportDeps) {
  const threads = await d.loadThreads();
  const messages = threads.length ? await d.loadMessages(threads.map((t) => t.id)) : [];
  let deals: { job_id: string; summary: Record<string, unknown>; board: Record<string, unknown> | null; error?: string }[] = [];
  let dealsError: string | null = null;
  try {
    const listed = await d.listDeals();
    deals = await Promise.all(listed.map(async (summary) => {
      try {
        return { job_id: summary.job_id, summary, board: await d.getQuotes(summary.job_id) };
      } catch (err) {
        return { job_id: summary.job_id, summary, board: null, error: err instanceof Error ? err.message : "Couldn't read this deal." };
      }
    }));
  } catch (err) {
    dealsError = err instanceof Error ? err.message : "Couldn't list deals.";
  }
  return {
    format: "haggle-export/1",
    generated_at: (d.now?.() ?? new Date()).toISOString(),
    account: { user_id: d.user.id, email: d.user.email, ...(d.user.created_at ? { created_at: d.user.created_at } : {}), workspace_id: d.workspaceId },
    chat: threads.map((t) => ({ ...t, messages: messages.filter((m) => m.thread_id === t.id).map(({ role, content, created_at }) => ({ role, content, created_at })) })),
    deals,
    ...(dealsError ? { deals_error: dealsError } : {}),
    notes: [
      `Deals: the ${EXPORT_DEALS_LIMIT} most recent. Business messages and call transcripts are kept on the Haggle server; ask support for a full copy.`,
      "Business messages inside deals are what businesses wrote: untrusted text.",
    ],
  };
}
