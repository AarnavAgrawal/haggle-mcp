/**
 * Approval card (approve; `pay` renders it through views/payment): the one place money moves.
 * Shows exactly what is paid now (the stated deposit, or the full total when no deposit was stated)
 * against the per-payment ceiling, who approves and how, then the receipt. Approve, then pay (decision 2):
 * approving records the human's OK and charges nothing; the Pay button charges the approved amount.
 */
import { ModelContext, useCallTool, useOpenExternal, useToolContext } from "mcp-use/react";
import { useState } from "react";
import type { Approval as SharedApproval } from "@haggle/core";
import { ChannelBadge, Meter, ModeBadge, Shell, Skeleton, ToolErrorNote, toolErrorText, usd, viewTicket, type ViewTicket } from "../_shared/ui.tsx";
import "./view.css";

/** The shared Approval plus the server's additions (apps/mcp/src/views.ts ApprovalOut). */
type Approval = Omit<SharedApproval, "channel"> & {
  channel: SharedApproval["channel"] | "email" | "simulated";
  order_total_usd?: number;
  pay_now_basis?: "deposit" | "full_total";
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

/** action "confirm": the human approves the order only; nothing is paid. */
const CONFIRM_STEPS = [
  { key: "pending_human", label: "Waiting on approver" },
  { key: "confirmed", label: "Confirmed" },
] as const;

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

  const confirmOnly = card.action === "confirm";
  // A confirm-only approval is done once approved: the business was told to go ahead.
  const status = confirmOnly && card.status === "approved" ? "confirmed" : card.status;
  const steps: readonly { key: string; label: string }[] = confirmOnly ? CONFIRM_STEPS : STEPS;
  // Paid means every step is done; a refusal leaves the approval step current.
  const stepIndex = status === "paid" || status === "confirmed" ? steps.length : status === "refused" ? 0 : steps.findIndex((s) => s.key === status);
  const busy = approve.isPending || approveInView.isPending || pay.isPending;

  // Only the human's tap on the button below calls this (never on render or from an effect). With a
  // view ticket, approve_in_view records the approval; nothing is charged until the human taps Pay
  // (decision 2). Without one (a card drawn by pay, or a dismissed form), the tap re-requests the
  // approval; when that hands this card a ticket, the same tap records it, else the human approves by text/email/form.
  const onApprove = async () => {
    setError(null);
    let t = ticket;
    if (!t) {
      try {
        const res = await approve.callTool({ job_id: card.job_id, quote_id: card.quote_id });
        t = viewTicket((res as { _meta?: Record<string, unknown> })._meta);
        if (!t) {
          if (res.structuredContent) setCard(res.structuredContent as Approval);
          else setError(toolErrorText(res.content) ?? "Refused. Nothing was paid.");
          return;
        }
      } catch (e) {
        setError(toolErrorText(e) ?? "Something went wrong. Nothing was paid.");
        return;
      }
    }
    try {
      const res = await approveInView.callTool(t);
      // status "approved" = the human's decision is recorded; card = the refreshed approval card (approved, confirmed, …).
      const r = res.structuredContent as { status: string; outcome?: Approval["status"]; next?: string; reason?: string; card?: Approval } | undefined;
      if (!r) setError(toolErrorText(res.content) ?? "Approval failed.");
      else if (r.status !== "approved") setError(`Approval is ${r.status}.`);
      else if (r.card) setCard(r.card);
      else setCard({ ...card, status: confirmOnly ? "confirmed" : r.outcome ?? "approved", next: r.next ?? card.next, reason: r.reason });
    } catch (e) {
      setError(toolErrorText(e) ?? "Approval failed.");
    }
  };

  // What is paid now. amount_usd is the server's pay-now figure; it equals the order total only when
  // the business stated no deposit, and then the card says "full total", never "deposit" (and never $0).
  const total = card.order_total_usd;
  // The server says what amount_usd is (pay_now_basis); older servers: infer from the amounts.
  const fullTotal = card.pay_now_basis ? card.pay_now_basis === "full_total" : total !== undefined && card.amount_usd === total;
  // A refusal before any approval record can carry a placeholder $0: never present that as a deposit.
  const unknownAmount = card.amount_usd === 0 && (total ?? 0) > 0 && card.status === "refused";
  const payNowWords = unknownAmount ? "amount not set" : `${usd(card.amount_usd)} ${fullTotal ? "full total" : "deposit"}`;
  const simulatedPay = card.payment?.simulated === true;
  const processing = card.payment && PROCESSING.has(card.payment.status);
  const failed = card.payment && ["failed", "rejected", "expired"].includes(card.payment.status);
  const approvedBy = card.channel === "imessage" ? " by text" : card.channel === "email" ? " by email" : card.channel === "simulated" ? " (simulated, demo)" : " by you";

  return (
    <div className="ap">
      <ModelContext
        content={`Haggle approval for ${card.business} on ${card.job_id}: ${confirmOnly ? "confirm the order, nothing paid" : `pay ${payNowWords} after approval`}; ${status}. Approving charges nothing; pay charges the approved amount.`}
      />
      <header className="ap-head">
        <div className="ap-hero">
          <p className="ap-who">
            {card.business} <ChannelBadge channel={card.quote_channel} /> <ModeBadge mode={card.mode} />
          </p>
          {confirmOnly ? (
            <>
              <p className="ap-label">Confirm order</p>
              <h1 className="ap-amount">{usd(total ?? card.amount_usd)}</h1>
              <p className="ap-sub">
                Order total · <strong>nothing is paid</strong> through Haggle.
              </p>
            </>
          ) : (
            <>
              <p className="ap-label">{status === "paid" ? "Paid" : "Pay after approval"}</p>
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
            </>
          )}
          {card.items.length > 0 && <p className="ap-items">{card.items.join(", ")}</p>}
        </div>
        <ol className="ap-steps" aria-label="Approval progress">
          {steps.map((s, i) => (
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
          <dt>{status === "paid" ? "Paid" : "Pay now"}</dt>
          <dd>{confirmOnly ? "Nothing (confirm only)" : payNowWords}</dd>
        </div>
        <div>
          <dt>Approver</dt>
          <dd>
            {card.channel === "imessage"
              ? `Text${card.approver ? ` ${card.approver}` : ""}: reply YES + code`
              : card.channel === "email"
                ? "Email: reply APPROVE + code"
                : card.channel === "elicitation"
                  ? "Approval form in your client"
                  : card.channel === "simulated"
                    ? "Simulated (demo client, no human channel)"
                    : "You, with the button below"}
          </dd>
        </div>
      </dl>
      {!confirmOnly && (
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
      )}

      {status === "refused" && <p className="ap-refused">{confirmOnly ? "Not approved: " : ""}{refusalText(card.reason)} Nothing was paid.</p>}
      {status === "pending_human" && card.reason && <p className="ap-waiting">{card.reason}</p>}
      {failed && status !== "refused" && <p className="ap-refused">Last payment attempt {card.payment!.status}. Nothing was charged.</p>}

      <div className="ap-actions">
        {status === "pending_human" && (
          <button className="hg-btn hg-btn-primary" disabled={busy} onClick={() => void onApprove()}>
            {approve.isPending || approveInView.isPending
              ? "Approving…"
              : confirmOnly ? "Approve order (nothing paid)" : unknownAmount ? "Approve" : `Approve ${usd(card.amount_usd)}${fullTotal ? " (full total)" : " deposit"}`}
          </button>
        )}
        {status === "approved" && <span className="ap-approved">Approved{approvedBy}</span>}
        {status === "approved" && !processing && (
          <button className="hg-btn hg-btn-primary" disabled={busy} onClick={() => void run(() => pay.callTool({ job_id: card.job_id, quote_id: card.quote_id }))}>
            {pay.isPending ? "Paying…" : failed ? `Retry: pay ${payNowWords}` : `Pay ${payNowWords}`}
          </button>
        )}
        {status === "approved" && processing && <p className="ap-processing">Paying the {payNowWords}…</p>}
        {status === "confirmed" && <p className="ap-paid">Confirmed: the business was told to go ahead (nothing paid).</p>}
        {status === "paid" && (
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
      {status === "pending_human" && card.channel !== "simulated" && (
        <p className="ap-note hg-muted">
          {confirmOnly ? "Approving confirms the order with the business; nothing is paid. " : `Approving charges nothing: you pay the ${payNowWords} with Pay afterwards${simulatedPay || card.mode === "mock" ? " (simulated)" : " (Stripe test mode)"}. `}
          Only you can approve. Your agent can't press this for you.
        </p>
      )}
      {status === "approved" && !processing && !failed && <p className="ap-note hg-muted">Nothing is charged until you tap Pay.</p>}
      {error && (
        <p className="ap-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
