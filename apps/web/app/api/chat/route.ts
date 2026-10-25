// POST /api/chat: one chat turn, streamed to the browser as newline-delimited JSON events
// (lib/chat/agent.ts ChatEvent), ending with {type:"done", thread_id}. Signed-out or workspace-less
// callers get 401/403 JSON (no redirects); 20 turns per user per 10 minutes.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { haggleConfig } from "@/lib/env";
import { haggleClient } from "@/lib/haggle";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { membership, sessionUser } from "@/lib/workspace";
import { runChatTurn, type ChatEvent } from "@/lib/chat/agent";
import { historyWindow } from "@/lib/chat/history";
import { chatConfig } from "@/lib/chat/limits";
import { limiters } from "@/lib/limiters";
import { appendMessages, createThread, loadMessages, setThreadJob, type Owner } from "@/lib/chat/store";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  thread_id: z.string().uuid().optional(),
  message: z.string().trim().min(1, "Type a message.").max(4000, "Keep a message under 4,000 characters."),
});

const json = (status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  Response.json({ error: { code, message }, ...extra }, { status, headers });

export async function POST(request: Request): Promise<Response> {
  const user = await sessionUser().catch(() => null);
  if (!user) return json(401, "unauthorized", "Sign in to chat with Haggle.");
  let workspaceId: string;
  try {
    const m = await membership(user.id);
    if (!m) return json(403, "no_workspace", "Finish onboarding to create your workspace first.", { next: "/onboarding" });
    workspaceId = m.workspace_id;
  } catch {
    return json(500, "workspace_lookup_failed", "Couldn't look up your workspace. Try again.");
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json(400, "invalid_input", parsed.error.issues[0]?.message ?? "Send { message } (1 to 4,000 characters).");
  const { thread_id, message } = parsed.data;

  // The site-wide daily cap first, so a turn the cap refuses doesn't use one of the user's turns.
  if (!(await limiters.chatDaily.take("site")).ok) {
    return json(429, "daily_limit", "The demo has reached today's chat limit. Try again tomorrow, or browse the deals already started.");
  }

  const limit = await limiters.chatTurns.take(user.id);
  if (!limit.ok) {
    return json(429, "rate_limited", `You've sent a lot of messages in the last 10 minutes. Try again in about ${Math.ceil(limit.retryAfterS / 60)} minute(s).`, { retry_after_s: limit.retryAfterS }, { "retry-after": String(limit.retryAfterS) });
  }

  const owner: Owner = { userId: user.id, workspaceId };
  const cfg = chatConfig();
  let db: ReturnType<typeof supabaseAdmin>;
  let haggle: ReturnType<typeof haggleClient>;
  try {
    db = supabaseAdmin();
    haggle = haggleClient(haggleConfig(), workspaceId);
  } catch (e) {
    return json(500, "server_not_configured", e instanceof Error ? e.message : "The web app isn't configured.");
  }

  let threadId: string;
  let history: Anthropic.Beta.BetaMessageParam[] = [];
  try {
    if (thread_id) {
      const loaded = await loadMessages(db, thread_id, owner);
      if (!loaded) return json(404, "thread_not_found", "That conversation doesn't exist or isn't yours. Start a new one.", { next: "/chat" });
      threadId = loaded.thread.id;
      history = loaded.messages;
    } else if (cfg.apiKey) {
      threadId = (await createThread(db, owner, message)).id;
    } else {
      threadId = "";
    }
  } catch {
    return json(500, "store_failed", "Couldn't load or save this conversation. Try again.");
  }

  // Stop the model and any tool call when the browser goes away.
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (e: ChatEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
        } catch {
          open = false;
        }
      };
      try {
        if (!cfg.apiKey) {
          send({ type: "error", message: "The chat isn't configured on this server: ANTHROPIC_API_KEY is not set. Ask the operator to add it." });
          return;
        }
        const turn = await runChatTurn({
          anthropic: new Anthropic({ apiKey: cfg.apiKey }),
          haggle,
          history: historyWindow(history),
          userText: message,
          model: cfg.model,
          signal: abort.signal,
          // The final done (with the thread id) is sent once the turn is saved.
          onEvent: (e) => (e.type === "done" ? undefined : send(e)),
        });
        try {
          await appendMessages(db, threadId, turn.messages);
          if (turn.jobId) await setThreadJob(db, threadId, turn.jobId);
        } catch {
          send({ type: "error", message: "This reply couldn't be saved to the conversation history." });
        }
      } catch {
        send({ type: "error", message: "Something went wrong on the server. Try again." });
      } finally {
        send({ type: "done", ...(threadId ? { thread_id: threadId } : {}) });
        open = false;
        try {
          controller.close();
        } catch {
          /* already closed by a disconnect */
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" },
  });
}
