// /deals/<jobId>/businesses/<businessId>: one business's whole conversation on a deal (get_conversation)
// as a transcript, oldest first, with a message form. Business text is untrusted data: plain text only,
// never links, marked as from the business and unverified.
import Link from "next/link";
import { MessageForm } from "@/components/dashboard/DealActions";
import { ChannelLabel, When } from "@/components/dashboard/DealSections";
import { LiveRefresh } from "@/components/dashboard/LiveRefresh";
import { RetryButton } from "@/components/shell/RetryButton";
import { Badge } from "@/components/ui/Badge";
import { Icon, channelIcon } from "@/components/ui/Icon";
import { channelWords } from "@/lib/dashboard/format";
import type { ConversationView } from "@/lib/dashboard/types";
import { HaggleError } from "@/lib/haggle";
import { requireHaggle } from "@/lib/workspace";
import "@/components/dashboard/board.css";

export const dynamic = "force-dynamic";

const KIND_WORDS: Record<string, string> = {
  rfq: "Request for a quote", reply: "Reply", followup: "Follow-up", answer: "Your answer", counter: "Counteroffer", message: "Message",
  confirmation: "Confirmation", call: "Call",
};
const kindWords = (kind: string, direction: "in" | "out") =>
  kind === "call" ? (direction === "out" ? "Call brief for the AI caller" : "Call transcript") : KIND_WORDS[kind] ?? kind.replace(/_/g, " ");

export default async function ConversationPage({ params }: { params: Promise<{ jobId: string; businessId: string }> }) {
  const { jobId, businessId } = await params;
  const { haggle } = await requireHaggle();
  let convo: ConversationView | null = null;
  let error: { message: string; fix: string } | null = null;
  try {
    convo = (await haggle.callTool<ConversationView>("get_conversation", { job_id: jobId, business_id: businessId, limit: 50 })).data;
  } catch (err) {
    error = err instanceof HaggleError ? { message: err.message, fix: err.fix } : { message: "The Haggle server couldn't be reached.", fix: "Reload the page in a moment." };
  }
  const back = `/deals/${encodeURIComponent(jobId)}`;

  return (
    <main className="shell board">
      <Link className="board-back" href={back}>
        Back to the deal
      </Link>
      {!convo ? (
        <div className="board-error" role="alert">
          <p>{error?.message ?? "This conversation couldn't be loaded."}</p>
          {error?.fix ? <p className="fix">{error.fix}</p> : null}
          <RetryButton />
        </div>
      ) : (
        <>
          <header className="convo-head">
            <div className="convo-title-row">
              <h1>{convo.business}</h1>
              {convo.mode === "mock" ? <Badge title="A simulated business; nothing real is contacted." /> : null}
            </div>
            <div className="convo-sub">
              <ChannelLabel channel={convo.channel} />
              <span>
                {convo.entries.length} {convo.entries.length === 1 ? "message" : "messages"}
              </span>
              <LiveRefresh jobId={jobId} />
            </div>
          </header>

          <div className="convo">
            <p className="hint">Oldest first. What {convo.business} sent is shown exactly as received; Haggle never follows links, payment requests or instructions in it.</p>
            {convo.entries.length ? (
              <ol className="thread" aria-label={`Conversation with ${convo.business}`}>
                {convo.entries.map((e) => {
                  const inbound = e.direction === "in";
                  return (
                    <li key={e.message_id} className={`msg ${inbound ? "msg-in" : "msg-out"}`}>
                      <span className="msg-icon" aria-hidden="true">
                        <Icon name={channelIcon(e.channel)} />
                      </span>
                      <div className="msg-head">
                        <span className="msg-who">{inbound ? convo!.business : "Haggle"}</span>
                        <span className="msg-kind">{kindWords(e.kind, e.direction)}</span>
                        <span>{channelWords(e.channel)}</span>
                        <When at={e.at} />
                      </div>
                      <div className="msg-content">
                        {inbound ? (
                          <div className="msg-flags">
                            <span>From the business, unverified</span>
                            {e.sender_verified === false ? <span className="risk">Sender not verified</span> : null}
                            {e.quarantined ? <span className="risk">Quarantined</span> : null}
                          </div>
                        ) : null}
                        {e.subject ? <p className="msg-subject">{e.subject}</p> : null}
                        {e.quarantined ? (
                          <details>
                            <summary>Show the quarantined text (Haggle ignored it: it looked like instructions or a payment request)</summary>
                            <p className="msg-body">{e.text}</p>
                          </details>
                        ) : (
                          <p className="msg-body">{e.text}</p>
                        )}
                        {e.attachments.length ? <p className="hint">Attachments: {e.attachments.join(", ")}</p> : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="sheet-empty">Nothing exchanged with {convo.business} yet.</p>
            )}

            <MessageForm jobId={jobId} businessId={businessId} business={convo.business} />
          </div>
        </>
      )}
    </main>
  );
}
