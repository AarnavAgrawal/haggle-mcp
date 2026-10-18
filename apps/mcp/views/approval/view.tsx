/**
 * Approval card (approve; `pay` renders it through views/payment): the one place money moves.
 * Shows the amount against the cap, who approves and how, then the receipt.
 */
import { ModelContext, useCallTool, useOpenExternal, useSendFollowUp, useToolContext } from "mcp-use/react";
import { useState } from "react";
import type { Approval as SharedApproval } from "@haggle/core";
import { ChannelBadge, ErrorNote, Meter, ModeBadge, Shell, Skeleton, usd, viewTicket, type ViewTicket } from "../_shared/ui.tsx";

/** The shared Approval plus the server's additions (apps/mcp/src/views.ts ApprovalOut). */
type Approval = Omit<SharedApproval, "channel"> & {
  channel: SharedApproval["channel"] | "simulated";
  order_total_usd?: number;
  demo?: string;
  payment?: { status: string; simulated: boolean };
};
import "./view.css";

const STEPS = [
  { key: "pending_human", label: "Waiting on approver" },
  { key: "approved", label: "Approved" },
  { key: "paid", label: "Paid" },
] as const;

export default function ApprovalView() {
  const ctx = useToolContext<"approve">();
  const initial = ctx.status === "ready" ? (ctx.toolOutput as Approval) : null;
  const ticket = ctx.status === "ready" ? viewTicket(ctx.meta) : undefined;

  if (!initial) {
    return (
      <Shell>
        {ctx.status === "error" ? <ErrorNote title="Couldn't load this approval." detail={ctx.error.message} /> : <Skeleton rows={4} />}
      </Shell>
    );
  }
  return (
    <Shell>
      <ApprovalCard initial={initial} ticket={ticket} />
    </Shell>
  );
}

function ApprovalCard({ initial, ticket }: { initial: Approval; ticket: ViewTicket | undefined }) {
  const approve = useCallTool("approve");
  const approveInView = useCallTool("approve_in_view");
  const pay = useCallTool("pay");
  const openExternal = useOpenExternal();
  const [card, setCard] = useState<Approval>(initial);
  const [error, setError] = useState<string | null>(null);

  const run = async (call: () => Promise<{ structuredContent?: unknown }>) => {
    setError(null);
    try {
      const res = await call();
      if (res.structuredContent) setCard(res.structuredContent as Approval);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Paid means every step is done; a refusal leaves the approval step current.
  const stepIndex = card.status === "paid" ? STEPS.length : card.status === "refused" ? 0 : STEPS.findIndex((s) => s.key === card.status);
  const busy = approve.isPending || approveInView.isPending || pay.isPending;

  // The human's tap: with a view ticket, approve_in_view records the approval; otherwise re-request it.
  const onApprove = async () => {
    if (!ticket) return run(() => approve.callTool({ job_id: card.job_id, quote_id: card.quote_id }));
    setError(null);
    try {
      const res = await approveInView.callTool(ticket);
      const r = res.structuredContent as { status: string; next: string };
      if (r.status === "approved") setCard({ ...card, status: "approved", next: r.next, reason: undefined });
      else setError(`Approval is ${r.status}.`);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const payNow = card.deposit_usd ?? card.amount_usd;
  const simulatedPay = card.payment?.simulated === true;
  const followUp = useSendFollowUp();

  return (
    <div className="ap">
      <ModelContext content={`Haggle approval for ${card.business} ${usd(card.amount_usd)} on ${card.job_id}: ${card.status}.`} />
      <header className="ap-head">
        <div>
          <p className="ap-who">
            {card.business} <ChannelBadge channel={card.quote_channel} /> <ModeBadge mode={card.mode} />
          </p>
          {card.order_total_usd !== undefined && card.order_total_usd !== card.amount_usd ? (
            <>
              <h1 className="ap-amount">{usd(card.order_total_usd)}</h1>
              <p className="ap-sub">order total · <strong>{usd(card.amount_usd)}</strong> deposit due now</p>
            </>
          ) : (
            <h1 className="ap-amount">{usd(card.amount_usd)}</h1>
          )}
          {card.items.length > 0 && <p className="hg-muted">{card.items.join(", ")}</p>}
        </div>
        <ol className="ap-steps" aria-label="Approval progress">
          {STEPS.map((s, i) => (
            <li key={s.key} className={i < stepIndex ? "is-done" : i === stepIndex ? "is-now" : ""}>
              {s.label}
            </li>
          ))}
        </ol>
      </header>

      <dl className="ap-facts">
        <div>
          <dt>Deposit due now</dt>
          <dd>{card.deposit_usd !== undefined ? usd(card.deposit_usd) : "None"}</dd>
        </div>
        <div>
          <dt>Payment ceiling</dt>
          <dd>{usd(card.cap_usd)}</dd>
        </div>
        <div>
          <dt>Approver</dt>
          <dd>
            {card.channel === "imessage"
              ? `iMessage${card.approver ? ` ${card.approver}` : ""}: reply YES + code`
              : card.channel === "elicitation"
                ? "Approval form in your client"
                : card.channel === "simulated"
                  ? "Simulated (demo client, no human channel)"
                  : "You, with the button below"}
          </dd>
        </div>
      </dl>
      <Meter
        value={card.amount_usd}
        max={Math.max(card.cap_usd, card.amount_usd)}
        tone={card.amount_usd > card.cap_usd ? "risk" : "win"}
        label={`${usd(card.amount_usd)} of a ${usd(card.cap_usd)} cap`}
      />
      <p className="ap-capnote hg-muted">
        {card.amount_usd <= card.cap_usd
          ? `${usd(card.cap_usd - card.amount_usd)} under the cap`
          : `${usd(card.amount_usd - card.cap_usd)} over the cap; payment will be refused`}
      </p>


      {card.status === "refused" && card.reason && <p className="ap-refused">Payment refused: {card.reason}</p>}
      {card.status === "pending_human" && card.reason && <p className="ap-waiting">{card.reason}</p>}

      <div className="ap-actions">
        {card.status === "pending_human" && (
          <button
            className="hg-btn hg-btn-primary"
            disabled={busy}
            onClick={() => void onApprove()}
          >
            {approve.isPending || approveInView.isPending ? "Approving…" : `Approve ${usd(card.amount_usd)}`}
          </button>
        )}
        {card.status === "approved" && (
          <button className="hg-btn hg-btn-primary" disabled={busy} onClick={() => void run(() => pay.callTool({ job_id: card.job_id, quote_id: card.quote_id }))}>
            {pay.isPending ? "Paying…" : `Pay ${usd(payNow)} deposit`}
          </button>
        )}
        {card.status === "paid" && (
          <p className="ap-paid">
            {usd(card.amount_usd)} deposit paid{card.paid_at ? ` ${new Date(card.paid_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
            {simulatedPay ? " · simulated (demo), no money moved" : " · Stripe test mode"}
          </p>
        )}
        {card.receipt_url && (
          <button className="hg-btn" onClick={() => void openExternal({ url: card.receipt_url! }).catch(() => {})}>
            View receipt
          </button>
        )}
      </div>
      {card.status === "pending_human" && card.channel !== "simulated" && <p className="ap-note hg-muted">Only you can approve. Your agent can't press this for you.</p>}
      {error && (
        <p className="ap-error" role="alert">
          {error}
        </p>
      )}
      <button className="db-link ap-back" onClick={() => void followUp({ prompt: `Show the Haggle deal board for job ${card.job_id}.` }).catch(() => {})}>
        Back to the deal board
      </button>
    </div>
  );
}
