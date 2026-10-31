"use client";
// The conversation (DESIGN.md "Chat"): one reading column; the composer pinned to the bottom; Haggle's
// replies as plain text; deal calls as cards; other tool calls as one quiet line of what Haggle did.
// The live turn is held by the chat layout's session (components/chat/session.tsx): this page shows it
// when it is this page's conversation, otherwise its own server-rendered history.
import Link from "next/link";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { buttonClass } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Status } from "@/components/ui/Status";
import type { ToolCard } from "@/lib/chat/cards";
import type { DisplayItem } from "@/lib/chat/history";
import { DEMO_EXAMPLES } from "@/lib/demo";
import { Composer } from "./Composer";
import { DealCard, StartedCard } from "./DealCards";
import { RichText } from "./RichText";
import { newChatToken, useChatSession } from "./session";

export interface RecentThread {
  id: string;
  title: string;
  /** Relative time, computed on the server ("5m ago"). */
  when: string;
  deal: boolean;
}

/** Example requests across kinds of purchase. A demo site's simulated businesses only cater. */
const EXAMPLES: { label: string; text: string }[] =
  process.env.NEXT_PUBLIC_HAGGLE_DEMO === "true"
    ? [
        { label: "Office lunch", text: DEMO_EXAMPLES[0]! },
        { label: "Hackathon breakfast", text: DEMO_EXAMPLES[1]! },
        { label: "Team dinner", text: DEMO_EXAMPLES[2]! },
      ]
    : [
        { label: "Catering", text: "Lunch for 60 next Friday in SoMa, 12 vegetarian, under $2,500" },
        { label: "Repair", text: "Fix a leaking kitchen sink in my Mission apartment this week" },
        { label: "Event rentals", text: "100 chairs and 10 tables for a Saturday party in Oakland, delivered and picked up" },
      ];

/** What Haggle did, in the past tense (a stored chip only has the tool's name). */
const DONE_WORDS: Record<string, string> = {
  wait_for_update: "Checked for updates",
  get_quotes: "Read the quotes",
  list_deals: "Looked up your deals",
  get_conversation: "Read the conversation",
  answer_business: "Answered the business",
  send_message: "Sent a message",
  negotiate: "Negotiated",
  cancel_deal: "Cancelled the deal",
  ask: "Estimated a price",
  discover: "Searched for businesses",
  business_profile: "Read a business profile",
  check_price: "Checked the price",
  get_identity: "Read your settings",
};

type ToolItem = Extract<DisplayItem, { kind: "tool" }>;
type Row =
  | { kind: "item"; key: number; item: Exclude<DisplayItem, ToolItem> }
  | { kind: "steps"; key: number; steps: ToolItem[] }
  | { kind: "card"; key: number; card: ToolCard; active: boolean };

/** Rows to draw: hidden chips dropped (a deal call shows as its card; a running tool as the working line), steps grouped. */
function toRows(items: DisplayItem[], sending: boolean): Row[] {
  const started = new Set(items.flatMap((it) => (it.kind === "card" && it.card.kind === "started" ? [it.card.job_id] : [])));
  let lastUser = -1;
  let lastCard = -1;
  items.forEach((it, i) => {
    if (it.kind === "user") lastUser = i;
    if (it.kind === "card") lastCard = i;
  });
  const rows: Row[] = [];
  items.forEach((it, i) => {
    if (it.kind === "tool") {
      if (it.status === "start" || (it.name === "deal" && it.status !== "error")) return;
      const prev = rows[rows.length - 1];
      if (prev?.kind === "steps") prev.steps.push(it);
      else rows.push({ kind: "steps", key: i, steps: [it] });
      return;
    }
    if (it.kind === "card") {
      rows.push({ kind: "card", key: i, card: it.card, active: !sending && i === lastCard && lastUser < i });
      return;
    }
    if (it.kind === "deal" && started.has(it.job_id)) return;
    rows.push({ kind: "item", key: i, item: it });
  });
  return rows;
}

const Message = memo(function Message({ item }: { item: Exclude<DisplayItem, ToolItem> }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="chat-msg chat-msg-user">
          <span className="sr-only">You said: </span>
          {item.text}
        </div>
      );
    case "assistant":
      return (
        <div className="chat-msg chat-msg-assistant">
          <span className="sr-only">Haggle: </span>
          <RichText text={item.text} />
        </div>
      );
    case "deal":
      return <StartedCard jobId={item.job_id} />;
    case "error":
      return (
        <p className="chat-error" role="alert">
          <Icon name="x" />
          <span>{item.text}</span>
        </p>
      );
    case "card":
      return null;
  }
});

function Steps({ steps }: { steps: ToolItem[] }) {
  return (
    <ul className="chat-steps" aria-label="What Haggle did">
      {steps.map((s, i) =>
        s.status === "error" ? (
          <li key={i} className="chat-step chat-step-error">
            <Icon name="x" />
            <span>{s.summary}</span>
          </li>
        ) : (
          <li key={i} className="chat-step">
            <Icon name="check" />
            <span>{DONE_WORDS[s.name] ?? (s.summary === s.name.replace(/_/g, " ") ? "Done" : s.summary)}</span>
          </li>
        ),
      )}
    </ul>
  );
}

const firstUserText = (items: DisplayItem[]) => items.find((x): x is Extract<DisplayItem, { kind: "user" }> => x.kind === "user")?.text;
const lastDealId = (items: DisplayItem[]): string | undefined => {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "deal") return it.job_id;
    if (it.kind === "card" && it.card.kind === "started") return it.card.job_id;
  }
  return undefined;
};

export function Chat({ threadId, initial, title, recent }: { threadId: string | null; initial: DisplayItem[]; title?: string | null; recent?: RecentThread[] }) {
  const [token] = useState(newChatToken);
  const { state, send, stop, draft } = useChatSession();
  const live = state.owner === token || (threadId !== null && state.threadId === threadId);
  const items = live ? state.items : initial;
  const sending = live && state.sending;
  const working = live ? state.working : null;

  const [text, setText] = useState(() => (live ? draft.current : ""));
  const [placeholder, setPlaceholder] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const empty = items.length === 0;
  const rows = useMemo(() => toRows(items, sending), [items, sending]);
  const last = items[items.length - 1];
  const showWorking = sending && (working !== null || last?.kind !== "assistant");
  const heading = title || firstUserText(items) || "New request";
  const dealId = useMemo(() => lastDealId(items), [items]);

  const onChange = useCallback(
    (v: string) => {
      setText(v);
      draft.current = v;
    },
    [draft],
  );

  const sendText = useCallback(
    (message: string) => {
      pinned.current = true;
      send(message, { owner: token, threadId: live ? (state.threadId ?? threadId) : threadId, base: items });
      setText("");
      draft.current = "";
      setPlaceholder(null);
      inputRef.current?.focus();
    },
    [send, token, live, state.threadId, threadId, items, draft],
  );

  const focusComposer = useCallback((p?: string) => {
    if (p) setPlaceholder(p);
    inputRef.current?.focus();
  }, []);
  const startDeal = useCallback(() => sendText("Yes, start the deal."), [sendText]);

  // Focus the box on arrival where there's a real keyboard (a phone would pop its keyboard up).
  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus({ preventScroll: true });
  }, []);

  // Stay at the newest message, unless the person has scrolled up to read.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [rows, showWorking]);
  const onScroll = useCallback(() => {
    const el = logRef.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

  return (
    <main className="chat-layout" data-empty={empty || undefined}>
      <section className="chat-main" aria-label="Chat with Haggle">
        {empty ? (
          <div className="chat-intro chat-col">
            <h1>What do you need quotes for?</h1>
            <p>Haggle emails, calls and texts businesses for you, and sends nothing until you confirm.</p>
          </div>
        ) : (
          <header className="chat-head">
            <div className="chat-col chat-head-row">
              <h1 className="chat-head-title">{heading}</h1>
              {dealId ? (
                <Link className={buttonClass("quiet", { size: "s" })} href={`/deals/${encodeURIComponent(dealId)}`}>
                  Deal board
                </Link>
              ) : null}
            </div>
          </header>
        )}
        <div className="chat-log" ref={logRef} onScroll={onScroll} role="log" aria-label="Conversation" aria-busy={sending} hidden={empty}>
          <div className="chat-col chat-thread">
            {rows.map((r) =>
              r.kind === "item" ? (
                <Message key={r.key} item={r.item} />
              ) : r.kind === "steps" ? (
                <Steps key={r.key} steps={r.steps} />
              ) : (
                <DealCard key={r.key} card={r.card} active={r.active} onStart={startDeal} onFocusComposer={focusComposer} />
              ),
            )}
            {showWorking ? (
              <p className="chat-working">
                <Status tone="live">{working ?? "Thinking"}</Status>
              </p>
            ) : null}
          </div>
        </div>
        <Composer
          value={text}
          onChange={onChange}
          onSend={() => sendText(text)}
          onStop={stop}
          sending={sending}
          placeholder={placeholder ?? (empty ? "Lunch for 40 next Thursday in SoMa, under $1,500" : "Reply to Haggle")}
          inputRef={inputRef}
          hint={empty}
        />
        {empty ? (
          <div className="chat-start chat-col">
            <section aria-labelledby="chat-examples">
              <h2 id="chat-examples" className="chat-start-label">
                Examples
              </h2>
              <ul className="chat-examples">
                {EXAMPLES.map((x) => (
                  <li key={x.text}>
                    <button type="button" onClick={() => sendText(x.text)}>
                      <span className="chat-example-kind">{x.label}</span>
                      <span className="chat-example-text">{x.text}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
            {recent && recent.length ? (
              <section aria-labelledby="chat-recent">
                <h2 id="chat-recent" className="chat-start-label">
                  Recent
                </h2>
                <ul className="chat-recent">
                  {recent.map((t) => (
                    <li key={t.id}>
                      <Link href={`/chat/${t.id}`}>
                        <span className="chat-recent-title">{t.title}</span>
                        {t.deal ? (
                          <Status tone="ok" className="chat-recent-deal">
                            Deal started
                          </Status>
                        ) : null}
                        <span className="chat-recent-when">{t.when}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : null}
        <p className="sr-only" role="status">
          {sending ? `Haggle is working${working ? `: ${working}` : ""}` : ""}
        </p>
      </section>
    </main>
  );
}
