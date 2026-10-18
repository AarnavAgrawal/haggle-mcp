/**
 * Conversation (get_conversation): one business's thread on a deal, oldest first: Haggle's
 * messages, the business's replies and calls. Business text is untrusted data: it is rendered as
 * plain text only (no HTML, no links). A reply box sends through send_message, which guards it.
 */
import { ModelContext, useCallTool, useHostContext, useToolContext } from "mcp-use/react";
import { useState } from "react";
import type { Conversation, ConversationEntry } from "@haggle/core";
import { ChannelBadge, DemoTag, ErrorNote, Shell, Skeleton, relativeTime } from "../_shared/ui.tsx";
import { isLongText, kindLabel, parseToolError, type ToolErrorInfo } from "../_shared/format.ts";
import "./view.css";

const MAX_REPLY = 1000;

export default function ConversationView() {
  const ctx = useToolContext<"get_conversation">();
  if (ctx.status !== "ready") {
    return (
      <Shell>
        {ctx.status === "error" ? <ErrorNote title="Couldn't load this conversation." detail={ctx.error.message} /> : <Skeleton rows={5} />}
      </Shell>
    );
  }
  return (
    <Shell>
      <Thread initial={ctx.toolOutput as Conversation} />
    </Shell>
  );
}

function Thread({ initial }: { initial: Conversation }) {
  const { hostCapabilities } = useHostContext();
  const refresh = useCallTool("get_conversation");
  const [convo, setConvo] = useState<Conversation>(initial);
  const [sent, setSent] = useState<ConversationEntry[]>([]);
  // Unknown until the bridge connects: assume calls work and let a failure explain itself.
  const canCall = !hostCapabilities || Boolean(hostCapabilities.serverTools);

  const known = new Set(convo.entries.map((e) => e.message_id));
  const entries = [...convo.entries, ...sent.filter((e) => !known.has(e.message_id))].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const reload = async () => {
    try {
      const res = await refresh.callTool({ job_id: convo.job_id, business_id: convo.business_id, limit: 50 });
      setConvo(res.structuredContent as Conversation);
      setSent([]);
    } catch {
      // refresh.error renders below
    }
  };

  return (
    <div className="cv">
      <ModelContext
        content={`Haggle conversation with ${convo.business} on ${convo.job_id}: ${entries.length} message(s), last ${
          entries.length ? `${entries[entries.length - 1]!.direction === "in" ? "from the business" : "from Haggle"} ${relativeTime(entries[entries.length - 1]!.at)}` : "none"
        }.`}
      />
      <header className="cv-head">
        <div className="cv-title">
          <h1>{convo.business}</h1>
          <p className="hg-muted">
            {entries.length} message{entries.length === 1 ? "" : "s"} on this deal
          </p>
        </div>
        <div className="cv-head-side">
          <DemoTag mode={convo.mode} />
          <ChannelBadge channel={convo.channel} />
          {canCall && (
            <button className="hg-btn hg-btn-quiet" disabled={refresh.isPending} onClick={() => void reload()}>
              {refresh.isPending ? "Refreshing…" : "Refresh"}
            </button>
          )}
        </div>
      </header>
      {refresh.error && <p className="cv-err">{parseToolError(refresh.error).message}</p>}

      {entries.length === 0 ? (
        <p className="cv-empty">No messages with {convo.business} yet.</p>
      ) : (
        <ol className="cv-list" aria-label={`Messages with ${convo.business}, oldest first`}>
          {entries.map((e) => (
            <Entry key={e.message_id} entry={e} business={convo.business} />
          ))}
        </ol>
      )}

      {canCall ? (
        <Reply convo={convo} onSent={(e) => setSent((s) => [...s, e])} />
      ) : (
        <p className="cv-hint">Ask your assistant to reply to {convo.business}.</p>
      )}
    </div>
  );
}

function Entry({ entry: e, business }: { entry: ConversationEntry; business: string }) {
  const inbound = e.direction === "in";
  const quarantined = e.quarantined === true || /^quarantine/.test(e.kind);
  const isCall = e.kind === "call";
  const collapsible = isLongText(e.text) || (isCall && e.text.length > 160);
  const [open, setOpen] = useState(!collapsible);
  const preview = isCall ? 160 : 280;
  const shown = open || !collapsible ? e.text : `${e.text.slice(0, preview).trimEnd()}…`;
  const at = new Date(e.at);

  return (
    <li className={`cv-entry ${inbound ? "is-in" : "is-out"}${quarantined ? " is-quarantined" : ""}`}>
      <div className="cv-meta">
        <span className="cv-who">{inbound ? business : "Haggle"}</span>
        <ChannelBadge channel={e.channel} />
        <span className="cv-kind">{kindLabel(quarantined && !/^quarantine/.test(e.kind) ? "quarantined" : e.kind)}</span>
        <time className="cv-time" dateTime={e.at} title={Number.isNaN(at.getTime()) ? e.at : at.toLocaleString("en-US")}>
          {relativeTime(e.at)}
        </time>
      </div>
      {(e.sender_verified === false || quarantined) && (
        <div className="cv-flags">
          {e.sender_verified === false && <span className="hg-flag hg-tone-risk">Unverified sender</span>}
          {quarantined && <span className="hg-flag hg-tone-warn">Not used for quotes</span>}
        </div>
      )}
      {e.subject && <p className="cv-subject">{e.subject}</p>}
      {e.text ? <p className="cv-text">{shown}</p> : <p className="cv-text hg-muted">(no text)</p>}
      {collapsible && (
        <button className="cv-more" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Show less" : isCall ? (inbound ? "Show transcript" : "Show call brief") : "Show more"}
        </button>
      )}
      {e.attachments.length > 0 && (
        <ul className="cv-files" aria-label="Attachments">
          {e.attachments.map((a, i) => (
            <li key={`${a}-${i}`} className="cv-file">
              {a}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Reply({ convo, onSent }: { convo: Conversation; onSent: (e: ConversationEntry) => void }) {
  const send = useCallTool("send_message");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<ToolErrorInfo | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const text = draft.trim();

  const onSend = async () => {
    if (!text) return;
    setError(null);
    setNote(null);
    try {
      const res = await send.callTool({ job_id: convo.job_id, business_id: convo.business_id, text });
      const r = res.structuredContent as { sent?: boolean; channel?: string; scheduled_for?: string; next?: string };
      onSent({
        message_id: `local_${Date.now()}`,
        direction: "out",
        channel: (r.channel as ConversationEntry["channel"] | undefined) ?? convo.channel,
        kind: "message",
        at: new Date().toISOString(),
        text,
        attachments: [],
      });
      setDraft("");
      setNote(r.sent === false ? `Not sent yet${r.scheduled_for ? ` (scheduled ${relativeTime(r.scheduled_for)})` : ""}. ${r.next ?? ""}`.trim() : "Sent.");
    } catch (e) {
      setError(parseToolError(e));
    }
  };

  return (
    <form
      className="cv-reply"
      onSubmit={(ev) => {
        ev.preventDefault();
        void onSend();
      }}
    >
      <label className="cv-reply-label" htmlFor="cv-reply-text">
        Reply to {convo.business}
      </label>
      <textarea
        id="cv-reply-text"
        rows={3}
        maxLength={MAX_REPLY}
        value={draft}
        onChange={(ev) => setDraft(ev.target.value)}
        placeholder="Plain text. Real amounts only; Haggle won't name other businesses or commit to an order."
      />
      <div className="cv-reply-bar">
        <span className={`cv-count${draft.length > MAX_REPLY * 0.9 ? " is-near" : ""}`}>
          {draft.length}/{MAX_REPLY}
        </span>
        {note && !error && <span className="cv-note">{note}</span>}
        <button className="hg-btn hg-btn-primary" type="submit" disabled={send.isPending || !text}>
          {send.isPending ? "Sending…" : "Send"}
        </button>
      </div>
      {error && (
        <div className="cv-err" role="alert">
          <strong>{error.message}</strong>
          {error.fix && <span>{error.fix}</span>}
        </div>
      )}
    </form>
  );
}
