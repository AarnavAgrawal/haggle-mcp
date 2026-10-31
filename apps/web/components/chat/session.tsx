"use client";
// The live conversation, held by the chat layout (app/(app)/chat/layout.tsx) instead of the page, so
// it survives the page remount a router.refresh() causes once a thread has its own URL (/chat ->
// /chat/<id> is a different page). The stream reader lives here too: refreshing the shell's rail
// mid-turn (a deal just started) never cuts the turn off.
//
// A page shows the session when it started it (its mount token) or when it is the same thread;
// otherwise it shows its own server-rendered history. Streamed events are applied once per
// animation frame, so a fast stream costs one render per frame, not one per token.
import { useRouter } from "next/navigation";
import { createContext, startTransition, use, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatEvent } from "@/lib/chat/agent";
import { applyEvent } from "@/lib/chat/events";
import type { DisplayItem } from "@/lib/chat/history";

export interface ChatSessionState {
  /** The mount token of the page that started this session. */
  owner: string | null;
  threadId: string | null;
  items: DisplayItem[];
  sending: boolean;
  /** What Haggle is doing right now ("Checking for updates"), while a tool runs. */
  working: string | null;
}

interface ChatSessionApi {
  state: ChatSessionState;
  /** Sends a message. `base` is what the page shows now (its history when the session isn't its own). */
  send(text: string, from: { owner: string; threadId: string | null; base: DisplayItem[] }): void;
  stop(): void;
  /** The text being typed, kept across a remount. */
  draft: { current: string };
}

const EMPTY: ChatSessionState = { owner: null, threadId: null, items: [], sending: false, working: null };
const Ctx = createContext<ChatSessionApi | null>(null);

export function useChatSession(): ChatSessionApi {
  const v = use(Ctx);
  if (!v) throw new Error("useChatSession needs <ChatSessionProvider> (app/(app)/chat/layout.tsx)");
  return v;
}

let tokens = 0;
/** A token per mounted chat page. */
export const newChatToken = () => `chat-${++tokens}`;

/** Chips still spinning when a turn ends ended with it. */
const settle = (xs: DisplayItem[]) => xs.map((it) => (it.kind === "tool" && it.status === "start" ? { ...it, status: "done" as const } : it));

export function ChatSessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<ChatSessionState>(EMPTY);
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  });
  const abortRef = useRef<AbortController | null>(null);
  const genRef = useRef(0);
  const draft = useRef("");

  useEffect(() => () => abortRef.current?.abort(), []);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const send = useCallback<ChatSessionApi["send"]>(
    (text, from) => {
      const message = text.trim();
      const cur = stateRef.current;
      const mine = cur.owner === from.owner || (from.threadId !== null && cur.threadId === from.threadId);
      if (!message || (mine && cur.sending)) return;
      // A new session (another thread, or a new chat) replaces the old one; its stream stops.
      abortRef.current?.abort();
      const gen = ++genRef.current;
      const ac = new AbortController();
      abortRef.current = ac;
      let threadId = from.threadId;
      const next: ChatSessionState = { owner: from.owner, threadId, items: [...from.base, { kind: "user", text: message }], sending: true, working: null };
      stateRef.current = next;
      setState(next);

      // Events wait for the next frame and are applied together.
      let queue: ChatEvent[] = [];
      let frame = 0;
      const flush = () => {
        frame = 0;
        if (gen !== genRef.current || !queue.length) return;
        const batch = queue;
        queue = [];
        setState((s) => {
          let items = s.items;
          let working = s.working;
          for (const e of batch) {
            items = applyEvent(items, e);
            if (e.type === "tool") working = e.status === "start" ? e.summary : null;
            else if (e.type === "text") working = null;
          }
          return { ...s, items, working };
        });
      };
      const push = (e: ChatEvent) => {
        queue.push(e);
        if (!frame) frame = requestAnimationFrame(flush);
      };
      const fail = (msg: string) => push({ type: "error", message: msg });

      void (async () => {
        let dealStarted = false;
        try {
          const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message, ...(threadId ? { thread_id: threadId } : {}) }),
            signal: ac.signal,
          });
          if (!res.ok || !res.body) {
            const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
            fail(body.error?.message ?? (res.status === 401 ? "Your session ended. Sign in again." : `The chat failed (HTTP ${res.status}). Try again.`));
            return;
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              let e: ChatEvent;
              try {
                e = JSON.parse(line) as ChatEvent;
              } catch {
                continue;
              }
              if (e.type === "done") {
                if (e.thread_id && e.thread_id !== threadId && gen === genRef.current) {
                  const id = e.thread_id;
                  threadId = id;
                  setState((s) => ({ ...s, threadId: id }));
                  // The URL now resumes this conversation (only if the person is still on the new chat).
                  if (window.location.pathname === "/chat") window.history.replaceState(null, "", `/chat/${id}`);
                }
              } else {
                if (e.type === "deal") dealStarted = true;
                push(e);
              }
            }
          }
        } catch (err) {
          if ((err as Error).name !== "AbortError") fail("Lost the connection to Haggle. Try again.");
        } finally {
          if (frame) cancelAnimationFrame(frame);
          flush();
          if (abortRef.current === ac) abortRef.current = null;
          if (gen === genRef.current) setState((s) => ({ ...s, items: settle(s.items), sending: false, working: null }));
          // The shell's rail lists deals: refresh it once the turn that started one is saved.
          if (dealStarted) startTransition(() => router.refresh());
        }
      })();
    },
    [router],
  );

  const api = useMemo<ChatSessionApi>(() => ({ state, send, stop, draft }), [state, send, stop]);
  return <Ctx value={api}>{children}</Ctx>;
}
