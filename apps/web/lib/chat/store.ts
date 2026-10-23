// Chat threads and messages in Supabase (supabase/migrations/301_web_chat.sql). The backend writes
// with the service-role client after checking the user's workspace membership, so every read here
// filters on the owner (user_id + workspace_id) itself; users can also read their own rows via RLS.
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { titleFrom } from "./history";

type MessageParam = Anthropic.Beta.BetaMessageParam;

export interface Owner {
  userId: string;
  workspaceId: string;
}

export interface ThreadRow {
  id: string;
  workspace_id: string;
  user_id: string;
  title: string | null;
  job_id: string | null;
  created_at: string;
  updated_at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isThreadId = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

/** A thread belongs to the user only in the workspace they act in. */
export const ownsThread = (row: Pick<ThreadRow, "user_id" | "workspace_id"> | null | undefined, owner: Owner): boolean =>
  !!row && row.user_id === owner.userId && row.workspace_id === owner.workspaceId;

function fail(what: string, error: { message: string } | null): never {
  throw new Error(`chat store: ${what} failed: ${error?.message ?? "no data"}`);
}

export async function createThread(db: SupabaseClient, owner: Owner, firstMessage: string): Promise<ThreadRow> {
  const { data, error } = await db
    .from("chat_threads")
    .insert({ workspace_id: owner.workspaceId, user_id: owner.userId, title: titleFrom(firstMessage) })
    .select("*")
    .single();
  if (error || !data) fail("creating the thread", error);
  return data as ThreadRow;
}

export async function listThreads(db: SupabaseClient, owner: Owner, limit = 30): Promise<Pick<ThreadRow, "id" | "title" | "job_id" | "updated_at">[]> {
  const { data, error } = await db
    .from("chat_threads")
    .select("id, title, job_id, updated_at")
    .eq("user_id", owner.userId)
    .eq("workspace_id", owner.workspaceId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) fail("listing threads", error);
  return (data ?? []) as Pick<ThreadRow, "id" | "title" | "job_id" | "updated_at">[];
}

/** The thread if this owner may see it, else null (unknown and not-yours look the same). */
export async function loadThread(db: SupabaseClient, threadId: string, owner: Owner): Promise<ThreadRow | null> {
  if (!isThreadId(threadId)) return null;
  const { data, error } = await db
    .from("chat_threads")
    .select("*")
    .eq("id", threadId)
    .eq("user_id", owner.userId)
    .eq("workspace_id", owner.workspaceId)
    .maybeSingle();
  if (error) fail("loading the thread", error);
  return ownsThread(data as ThreadRow | null, owner) ? (data as ThreadRow) : null;
}

/** The thread and its messages in order, or null when it isn't this owner's. */
export async function loadMessages(db: SupabaseClient, threadId: string, owner: Owner): Promise<{ thread: ThreadRow; messages: MessageParam[] } | null> {
  const thread = await loadThread(db, threadId, owner);
  if (!thread) return null;
  const { data, error } = await db.from("chat_messages").select("role, content").eq("thread_id", thread.id).order("id", { ascending: true });
  if (error) fail("loading messages", error);
  const messages = ((data ?? []) as { role: "user" | "assistant"; content: MessageParam["content"] }[]).map((r) => ({ role: r.role, content: r.content }) as MessageParam);
  return { thread, messages };
}

/** Appends the turn's messages in order (append-only) and bumps the thread. */
export async function appendMessages(db: SupabaseClient, threadId: string, messages: MessageParam[]): Promise<void> {
  const rows = messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ thread_id: threadId, role: m.role, content: m.content }));
  if (rows.length) {
    const { error } = await db.from("chat_messages").insert(rows);
    if (error) fail("saving messages", error);
  }
  const { error } = await db.from("chat_threads").update({ updated_at: new Date().toISOString() }).eq("id", threadId);
  if (error) fail("updating the thread", error);
}

export async function setThreadJob(db: SupabaseClient, threadId: string, jobId: string): Promise<void> {
  const { error } = await db.from("chat_threads").update({ job_id: jobId, updated_at: new Date().toISOString() }).eq("id", threadId);
  if (error) fail("recording the deal", error);
}
