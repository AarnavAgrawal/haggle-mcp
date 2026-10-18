/**
 * Approval card (approve; `pay` renders it through views/payment): the one place money moves.
 * Shows exactly what is paid now (the stated deposit, or the full total when no deposit was stated)
 * against the per-payment ceiling, who approves and how, then the receipt.
 */
import { ModelContext, useCallTool, useOpenExternal, useSendFollowUp, useToolContext } from "mcp-use/react";
import { useState } from "react";
import type { Approval as SharedApproval } from "@haggle/core";
import { ChannelBadge, Meter, ModeBadge, Shell, Skeleton, ToolErrorNote, toolErrorText, usd, viewTicket, type ViewTicket } from "../_shared/ui.tsx";
import "./view.css";

/** The shared Approval plus the server's additions (apps/mcp/src/views.ts ApprovalOut). */
type Approval = Omit<SharedApproval, "channel"> & {
  channel: SharedApproval["channel"] | "simulated";
  order_total_usd?: number;
  demo?: string;
  payment?: { status: string; simulated: boolean };
};

const STEPS = [
  { key: "pending_human", label: "Sent for approval" },
  { key: "approved", label: "Approved" },
  { key: "paid", label: "Paid" },
] as const;

const PROCESSING = new Set(["charging", "sent", "signed", "awaiting_invoice", "invoice_received"]);

/** Server refusal codes and reasons in plain words (the raw reason is kept when unknown). */
function refusalText(reason: string | undefined): string {
  if (!reason) return "Refused.";
  if (/total_not_firm/.test(reason)) return "The business gave an approximate total. Haggle can approve it once they confirm a firm total.";
  return reason;
}

export default function ApprovalView() {
  const ctx = useToolContext<"approve">();
  const initial = ctx.status === "ready" ? (ctx.toolOutput as Approval | undefined) : null;
  const ticket = ctx.status === "ready" ? viewTicket(ctx.meta) : undefined;

  if (!initial) {
    return (
      <Shell>
        {ctx.status === "error" ? (
          <ToolErrorNote title="Not approved. Nothing was paid." error={ctx.error} content={ctx.content} />
        ) : ctx.status === "ready" ? (
          <ToolErrorNote title="This approval didn't load. Nothing was paid." content={ctx.content} />
        ) : (
          <Skeleton rows={4} />
        )}
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
  const followUp = useSendFollowUp();
  const [card, setCard] = useState<Approval>(initial);
  const [error, setError] = useState<string | null>(null);

  const run = async (call: () => Promise<{ structuredContent?: unknown; content?: unknown }>) => {
    setError(null);
    try {
      const res = await call();
      if (res.structuredContent) setCard(res.structuredContent as Approval);
      else setError(toolErrorText(res.content) ?? "Refused. Nothing was paid.");
    } catch (e) {
      setError(toolErrorText(e) ?? "Something went wrong. Nothing was paid.");
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
      const r = res.structuredContent as { status: string; next: string } | undefined;
      if (r?.status === "approved") setCard({ ...card, status: "approved", next: r.next, reason: undefined });
      else setError(r ? `Approval is ${r.status}.` : toolErrorText(res.content) ?? "Approval failed.");
    } catch (e) {
      setError(toolErrorText(e) ?? "Approval failed.");
    }
  };

  // What is paid now. amount_usd is the server's pay-now figure; it equals the order total only when
  // the business stated no deposit, and then the card says "full total", never "deposit".
  const total = card.order_total_usd;
  const fullTotal = total !== undefined && card.amount_usd === total;
  // A refusal before any approval record can carry a placeholder $0: never present that as a deposit.
  const unknownAmount = card.amount_usd === 0 && (total ?? 0) > 0 && card.status === "refused";
  const payNowWords = unknownAmount ? "amount not set" : `${usd(card.amount_usd)} ${fullTotal ? "full total" : "deposit"}`;
  const simulatedPay = card.payment?.simulated === true;
  const processing = card.payment && PROCESSING.has(card.payment.status);
  const failed = card.payment && ["failed", "rejected", "expired"].includes(card.payment.status);

  return (
    <div className="ap">
      <ModelContext content={`Haggle approval for ${card.business}: pay ${payNowWords} now on ${card.job_id}; ${card.status}.`} />
      <header className="ap-head">
        <div className="ap-hero">
          <p className="ap-who">
            {card.business} <ChannelBadge channel={card.quote_channel} /> <ModeBadge mode={card.mode} />
          </p>
          <p className="ap-label">{card.status === "paid" ? "Paid" : "Pay now"}</p>
          <h1 className="ap-amount">{unknownAmount ? "—" : usd(card.amount_usd)}</h1>
          <p className="ap-sub">
            {unknownAmount ? (
              <>Order total {usd(total)}.</>
            ) : fullTotal ? (
              <>Full order total; {card.business} stated no deposit.</>
            ) : total !== undefined ? (
              <>
                Deposit on a <strong>{usd(total)}</strong> order.
              </>
            ) : (
              <>Deposit.</>
            )}
          </p>
          {card.items.length > 0 && <p className="ap-items">{card.items.join(", ")}</p>}
        </div>
        <ol className="ap-steps" aria-label="Approval progress">
          {STEPS.map((s, i) => (
            <li key={s.key} className={i < stepIndex ? "is-done" : i === stepIndex ? "is-now" : ""} aria-current={i === stepIndex ? "step" : undefined}>
              {s.label}
            </li>
          ))}
        </ol>
      </header>

      <dl className="ap-facts">
        <div>
          <dt>Order total</dt>
          <dd>{total !== undefined ? usd(total) : "Not given"}</dd>
        </div>
        <div>
          <dt>{card.status === "paid" ? "Paid now" : "Pay now"}</dt>
          <dd>{payNowWords}</dd>
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
      <div className="ap-cap">
        <Meter
          value={card.amount_usd}
          max={Math.max(card.cap_usd, card.amount_usd)}
          tone={card.amount_usd > card.cap_usd ? "risk" : "win"}
          label={`${usd(card.amount_usd)} of a ${usd(card.cap_usd)} per-payment ceiling`}
        />
        <p className="ap-capnote hg-muted">
          {card.amount_usd <= card.cap_usd
            ? `${usd(card.amount_usd)} of the ${usd(card.cap_usd)} per-payment ceiling`
            : `${usd(card.amount_usd - card.cap_usd)} over the ${usd(card.cap_usd)} per-payment ceiling; payment will be refused`}
        </p>
      </div>

      {card.status === "refused" && <p className="ap-refused">{refusalText(card.reason)} Nothing was paid.</p>}
      {card.status === "pending_human" && card.reason && <p className="ap-waiting">{card.reason}</p>}
      {failed && card.status !== "refused" && <p className="ap-refused">Last payment attempt {card.payment!.status}. Nothing was charged.</p>}

      <div className="ap-actions">
        {card.status === "pending_human" && (
          <button className="hg-btn hg-btn-primary" disabled={busy} onClick={() => void onApprove()}>
            {approve.isPending || approveInView.isPending ? "Approving…" : `Approve ${payNowWords}`}
          </button>
        )}
        {card.status === "approved" && (
          <span className="ap-approved">
            Approved{card.channel === "imessage" ? " by iMessage" : card.channel === "simulated" ? " (simulated, demo)" : ""}
          </span>
        )}
        {card.status === "approved" && !processing && (
          <button className="hg-btn hg-btn-primary" disabled={busy} onClick={() => void run(() => pay.callTool({ job_id: card.job_id, quote_id: card.quote_id }))}>
            {pay.isPending ? "Paying…" : failed ? `Retry: pay ${payNowWords}` : `Pay ${payNowWords}`}
          </button>
        )}
        {card.status === "approved" && processing && <p className="ap-processing">Paying the {payNowWords}…</p>}
        {card.status === "paid" && (
          <p className="ap-paid">
            {payNowWords} paid
            {card.paid_at ? ` ${new Date(card.paid_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
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
