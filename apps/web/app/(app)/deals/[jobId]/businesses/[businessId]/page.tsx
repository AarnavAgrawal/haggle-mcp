// /deals/<jobId>/businesses/<businessId>: one business's full thread on a deal (get_conversation),
// oldest first, with a message form. Business text is untrusted data: plain text only, never links.
import Link from "next/link";
import { MessageForm } from "@/components/dashboard/DealActions";
import { ChannelBadge } from "@/components/dashboard/DealSections";
import { LiveRefresh } from "@/components/dashboard/LiveRefresh";
import { stamp } from "@/lib/dashboard/format";
import type { ConversationView } from "@/lib/dashboard/types";
import { HaggleError } from "@/lib/haggle";
import { requireHaggle } from "@/lib/workspace";
import "@/components/dashboard/dashboard.css";

export const dynamic = "force-dynamic";

const KIND_WORDS: Record<string, string> = {
  rfq: "Request for quote", reply: "Reply", followup: "Follow-up", answer: "Answer", counter: "Counteroffer", message: "Message",
  confirmation: "Confirmation", call: "Call",
};
const kindWords = (kind: string, direction: "in" | "out") =>
  kind === "call" ? (direction === "out" ? "Call brief" : "Call transcript") : KIND_WORDS[kind] ?? kind.replace(/_/g, " ");

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
    <>
      <main className="shell stack">
        <Link className="dash-back" href={back}>
          ← Back to the deal
        </Link>
        {!convo ? (
          <p className="note note-risk" role="alert">
            {error?.message} <span className="fix">{error?.fix}</span>
          </p>
        ) : (
          <>
            <div className="dash-head">
              <div className="dash-title">
                <h1>{convo.business}</h1>
                <ChannelBadge channel={convo.channel} />
                {convo.mode === "mock" ? <span className="chip demo">DEMO data</span> : null}
              </div>
              <LiveRefresh jobId={jobId} />
            </div>
            <p className="hint">
              Everything Haggle sent and received, oldest first. Text from the business is shown exactly as received; Haggle never follows links or payment requests in it.
            </p>

            {convo.entries.length ? (
              <ol className="thread" aria-label={`Conversation with ${convo.business}`}>
                {convo.entries.map((e) => {
                  const inbound = e.direction === "in";
                  return (
                    <li key={e.message_id} className={`msg ${inbound ? "msg-in" : "msg-out"}`}>
                      <div className="msg-head">
                        <strong>{inbound ? convo!.business : "Haggle"}</strong>
                        <span>{inbound ? "to Haggle" : `to ${convo!.business}`}</span>
                        <ChannelBadge channel={e.channel} />
                        <span className="chip chip-plain">{kindWords(e.kind, e.direction)}</span>
                        <time dateTime={e.at}>{stamp(e.at)}</time>
                      </div>
                      {inbound ? (
                        <div className="dash-row dash-wrap">
                          <span className="untrusted-label">from the business, unverified</span>
                          {e.sender_verified === false ? <span className="chip chip-risk">sender not verified</span> : null}
                          {e.quarantined ? <span className="chip chip-risk">quarantined</span> : null}
                        </div>
                      ) : null}
                      {e.subject ? (
                        <div>
                          <strong>{e.subject}</strong>
                        </div>
                      ) : null}
                      {e.quarantined ? (
                        <details>
                          <summary>Show the quarantined text (Haggle ignored it: it looked like instructions or a payment request)</summary>
                          <p className="msg-body untrusted">{e.text}</p>
                        </details>
                      ) : (
                        <p className={`msg-body ${inbound ? "untrusted" : ""}`}>{e.text}</p>
                      )}
                      {e.attachments.length ? <div className="hint">Attachments: {e.attachments.join(", ")}</div> : null}
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="card muted">Nothing exchanged with {convo.business} yet.</p>
            )}

            <p className="note dash-next">
              <strong>Next:</strong> {convo.next}
            </p>

            <MessageForm jobId={jobId} businessId={businessId} business={convo.business} />
          </>
        )}
      </main>
    </>
  );
}
