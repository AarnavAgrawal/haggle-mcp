/**
 * Conversation (get_conversation): one business's thread on a deal, oldest first: Haggle's
 * messages, the business's replies and calls. Business text is untrusted data: it is rendered as
 * plain text only (no HTML, no links). A reply box sends through send_message, which guards it.
 */
import { ModelContext, useCallTool, useHostContext, useToolContext } from "mcp-use/react";
import { useState } from "react";
import type { Conversation, ConversationEntry } from "@haggle/core";
import { ChannelBadge, DemoTag, ErrorNote, Shell, Skeleton, relativeTime } from "../_shared/ui.tsx";
import { parseToolError } from "../_shared/format.ts";
import { EntryList, Reply, mergeEntries } from "./thread.tsx";
import "./view.css";

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

  const entries = mergeEntries(convo, sent);

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

      <EntryList entries={entries} business={convo.business} />

      {canCall ? (
        <Reply convo={convo} onSent={(e) => setSent((s) => [...s, e])} />
      ) : (
        <p className="cv-hint">Ask your assistant to reply to {convo.business}.</p>
      )}
    </div>
  );
}
