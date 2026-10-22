/**
 * One business's thread, shared by the conversation view (get_conversation) and the deal board's
 * inline Conversation panel. Business text is untrusted data: plain text only (no HTML, no links).
 * The reply box sends through send_message, which guards amounts, names and commitments.
 */
import { useCallTool } from "mcp-use/react";
import { useState } from "react";
import type { Conversation, ConversationEntry } from "@haggle/core";
import { ChannelBadge, relativeTime } from "../_shared/ui.tsx";
import { isLongText, kindLabel, parseToolError, type ToolErrorInfo } from "../_shared/format.ts";
import "./view.css";

const MAX_REPLY = 1000;

/** Server entries plus messages just sent from this UI (not yet in the server's thread), oldest first. */
export function mergeEntries(convo: Conversation, sent: ConversationEntry[]): ConversationEntry[] {
  const known = new Set(convo.entries.map((e) => e.message_id));
  return [...convo.entries, ...sent.filter((e) => !known.has(e.message_id))].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function EntryList({ entries, business }: { entries: ConversationEntry[]; business: string }) {
  if (entries.length === 0) return <p className="cv-empty">No messages with {business} yet.</p>;
  return (
    <ol className="cv-list" aria-label={`Messages with ${business}, oldest first`}>
      {entries.map((e) => (
        <Entry key={e.message_id} entry={e} business={business} />
      ))}
    </ol>
  );
}

export function Entry({ entry: e, business }: { entry: ConversationEntry; business: string }) {
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

export function Reply({ convo, onSent, compact }: { convo: Conversation; onSent: (e: ConversationEntry) => void; compact?: boolean }) {
  const send = useCallTool("send_message");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<ToolErrorInfo | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const text = draft.trim();
  const fieldId = `cv-reply-${convo.business_id}`;

  const onSend = async () => {
    if (!text) return;
    setError(null);
    setNote(null);
    try {
      const res = await send.callTool({ job_id: convo.job_id, business_id: convo.business_id, text });
      const r = res.structuredContent as { sent?: boolean; channel?: string; scheduled_for?: string; next?: string };
      // Only a message that really went out joins the thread; a scheduled one shows up when it's sent,
      // and one that wasn't sent or scheduled keeps its draft for another try.
      if (r.sent !== false) {
        onSent({
          message_id: `local_${Date.now()}`,
          direction: "out",
          channel: (r.channel as ConversationEntry["channel"] | undefined) ?? convo.channel,
          kind: "message",
          at: new Date().toISOString(),
          text,
          attachments: [],
        });
      }
      if (r.sent !== false || r.scheduled_for) setDraft("");
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
      <label className="cv-reply-label" htmlFor={fieldId}>
        Reply to {convo.business}
      </label>
      <textarea
        id={fieldId}
        rows={compact ? 2 : 3}
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
