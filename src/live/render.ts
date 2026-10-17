// PURE: HTML for the read-only live page (DESIGN.md §2.3 S2, demo §22 0:35).
//
// Everything shown here comes from the database, and much of it was written by
// vendors, so every string goes through esc(). Two things never appear on the
// page: approval codes (redacted from every message) and the approver's full
// email address (masked).
import type { ApprovalRow, JobRow, MessageRow, PaymentRow, QuoteRow, VendorRow } from "../db/queries.js";
import type { JobStatus } from "../jobs/stateMachine.js";
import { summarizeJob } from "../jobs/summary.js";
import { dietaryOk, pickBest } from "../tools/best.js";
import { maskEmail } from "../tools/format.js";

export interface JobSnapshot {
  job: JobRow;
  vendors: VendorRow[];
  quotes: QuoteRow[];
  messages: MessageRow[];
  approvals: ApprovalRow[]; // newest first
  payments: PaymentRow[];
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

const usd = (cents: number | null | undefined) =>
  cents === null || cents === undefined
    ? "—"
    : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** <time> that the page script rewrites into the viewer's local time. */
const time = (iso: string) => `<time datetime="${esc(iso)}">${esc(iso.slice(11, 16))} UTC</time>`;

/** Remove every approval code and approver address from text shown on the page. */
export function redact(text: string, approvals: Pick<ApprovalRow, "code" | "approver_email">[]): string {
  let out = text;
  for (const a of approvals) {
    if (/^\d{4}$/.test(a.code)) out = out.replace(new RegExp(`\\b${a.code}\\b`, "g"), "••••");
    out = out.replace(new RegExp(a.approver_email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), maskEmail(a.approver_email));
  }
  return out;
}

// ---------- Pieces ----------

const STEPS: { status: JobStatus; label: string }[] = [
  { status: "collecting", label: "Collecting" },
  { status: "negotiating", label: "Negotiating" },
  { status: "ready", label: "Ready" },
  { status: "awaiting_approval", label: "Awaiting approval" },
  { status: "approved", label: "Approved" },
  { status: "paid", label: "Paid" },
];

function progress(status: JobStatus): string {
  if (status === "cancelled" || status === "expired") {
    return `<p class="ended">This job ${status === "cancelled" ? "was cancelled" : "expired with no usable quotes"}.</p>`;
  }
  // payment_failed takes the "Approved" slot, shown in red.
  const failed = status === "payment_failed";
  const at = failed ? 4 : STEPS.findIndex((s) => s.status === status);
  const items = STEPS.map((s, i) => {
    const state = i < at ? "done" : i === at ? "now" : "todo";
    const label = failed && i === 4 ? "Payment failed" : s.label;
    return `<li class="${state}${failed && i === 4 ? " bad" : ""}">${esc(label)}</li>`;
  });
  return `<ol class="steps">${items.join("")}</ol>`;
}

const VENDOR_STATUS: Record<string, string> = {
  pending: "Not sent",
  contacted: "Waiting",
  replied: "Replied",
  declined: "Declined",
  no_reply: "No reply",
  bounced: "Bounced",
  send_failed: "Send failed",
};

function quotesTable(s: JobSnapshot): string {
  const best = pickBest(s.job, s.quotes);
  const quoteOf = new Map(s.quotes.map((q) => [q.vendor_id, q]));
  const rows = s.vendors.map((v) => {
    const q = quoteOf.get(v.id);
    const isBest = best !== null && q?.id === best.id;
    const diet = !q ? "—" : dietaryOk(s.job, q) ? "✓" : "✗";
    const prices =
      q && !q.available
        ? `<td colspan="3" class="muted">Can't do this date</td>`
        : `<td>${usd(q?.price_per_head_cents)}</td><td>${usd(q?.total_cents)}</td><td>${usd(q?.deposit_cents)}</td>`;
    const tags = (isBest ? ` <span class="tag">Best</span>` : "") + (q && q.round > 0 ? ` <span class="tag soft">Round ${q.round}</span>` : "");
    return `<tr class="${isBest ? "best" : ""}">
      <th scope="row">${esc(v.name)}${tags}</th>
      <td><span class="vs vs-${esc(v.status)}">${esc(VENDOR_STATUS[v.status] ?? v.status)}</span></td>
      ${prices}
      <td class="c">${diet}</td>
    </tr>`;
  });
  return `<table class="quotes">
    <thead><tr><th scope="col">Vendor</th><th scope="col">Status</th><th scope="col">Per head</th><th scope="col">Total</th><th scope="col">Deposit</th><th scope="col" class="c">Dietary</th></tr></thead>
    <tbody>${rows.join("")}</tbody>
  </table>`;
}

const APPROVAL_LABEL: Record<ApprovalRow["status"], string> = {
  pending: "Waiting for the human's reply",
  approved: "Approved by email",
  declined: "Declined",
  expired: "Expired",
  used: "Approved and used",
};

function approvalCard(s: JobSnapshot): string {
  const approval = s.approvals[0];
  if (!approval) return "";
  const vendor = s.vendors.find((v) => v.id === approval.vendor_id)?.name ?? "vendor";
  const payment = s.payments.find((p) => p.approval_id === approval.id);
  const paymentLine = payment
    ? `<p>Payment: <span class="pill pill-${payment.status === "succeeded" ? "approved" : "declined"}">${payment.status === "succeeded" ? "Charged" : "Failed"}</span>
       <span class="muted">Stripe test mode${payment.stripe_payment_intent_id ? ` · ${esc(payment.stripe_payment_intent_id)}` : ""}</span></p>`
    : "";
  return `<section class="card">
    <h2>Approval</h2>
    <p class="big">${usd(approval.amount_cents)} deposit to ${esc(vendor)}</p>
    <p><span class="pill pill-${esc(approval.status)}">${esc(APPROVAL_LABEL[approval.status])}</span>
      <span class="muted">sent to ${esc(maskEmail(approval.approver_email))} at ${time(approval.requested_at)}</span></p>
    ${paymentLine}
  </section>`;
}

const KIND_LABEL: Record<MessageRow["kind"], string> = {
  outreach: "Quote request",
  counter: "Counteroffer",
  approval_request: "Approval request",
  receipt: "Receipt",
  cancel_note: "Cancellation",
  reply: "Vendor reply",
  approval_reply: "Approval reply",
};

function messageCard(m: MessageRow, s: JobSnapshot): string {
  const vendor = s.vendors.find((v) => v.id === m.vendor_id)?.name;
  const sender = vendor ?? (m.from_address ? redact(m.from_address, s.approvals) : "unknown");
  const who = m.direction === "out" ? `To ${vendor ?? "the approver"}` : `From ${sender}`;
  const body = redact(m.body_text ?? "", s.approvals);
  const files = m.attachments.map((a) => `<span class="file">📎 ${esc(a.filename ?? a.content_type)}</span>`).join("");
  const auth =
    m.direction === "in" && m.sender_authenticated !== null
      ? `<span class="auth ${m.sender_authenticated ? "ok" : "warn"}">${m.sender_authenticated ? "Sender verified" : "Sender not verified"}</span>`
      : "";
  return `<li class="msg ${m.direction}">
    <div class="meta"><span class="kind">${esc(KIND_LABEL[m.kind] ?? m.kind)}</span> <span>${esc(who)}</span> ${auth} <span class="muted">${time(m.created_at)}</span></div>
    ${m.subject ? `<div class="subject">${esc(redact(m.subject, s.approvals))}</div>` : ""}
    ${body ? `<pre class="body">${esc(body.length > 1500 ? `${body.slice(0, 1500)}…` : body)}</pre>` : ""}
    ${files ? `<div class="files">${files}</div>` : ""}
  </li>`;
}

function eventLine(job: JobRow): string {
  const e = job.event;
  const diet = e.dietary.map((d) => `${d.count} ${d.need}`).join(", ");
  const budget = job.budget_per_head_cents ? `budget ${usd(job.budget_per_head_cents)}/head` : "";
  return [`${e.headcount} guests`, `${e.date} at ${e.time}`, e.location, diet, budget].filter(Boolean).map(esc).join(" · ");
}

const statusPill = (status: JobStatus) => `<span class="status st-${esc(status)}">${esc(status.replace(/_/g, " "))}</span>`;

// ---------- Fragments and pages ----------

/** The part of the job page that refreshes. */
export function renderJobFragment(s: JobSnapshot): string {
  const summary = summarizeJob(s.job, s.vendors, s.quotes, s.approvals[0] ?? null);
  const newestFirst = [...s.messages].reverse();
  const count = `${s.messages.length} email${s.messages.length === 1 ? "" : "s"}`;
  return `<header class="job">
      <h1>Job QB-${esc(s.job.short_code)} ${statusPill(s.job.status)}</h1>
      <p class="event">${eventLine(s.job)}</p>
      <p class="summary">${esc(summary)}</p>
      ${progress(s.job.status)}
    </header>
    <div class="grid">
      <div>
        <section class="card"><h2>Quotes</h2>${s.vendors.length ? quotesTable(s) : `<p class="muted">No vendors yet.</p>`}</section>
        ${approvalCard(s)}
      </div>
      <section class="card">
        <h2>Inbox <span class="muted">${count}</span></h2>
        ${newestFirst.length ? `<ol class="inbox">${newestFirst.map((m) => messageCard(m, s)).join("")}</ol>` : `<p class="muted">No email yet.</p>`}
      </section>
    </div>`;
}

/** The list of recent jobs (also refreshes). */
export function renderIndex(jobs: JobRow[], token: string): string {
  if (jobs.length === 0) {
    return `<header class="job"><h1>Recent jobs</h1></header><p class="muted">No jobs yet. Ask your agent to call create_quote_request.</p>`;
  }
  const rows = jobs.map(
    (j) => `<li><a href="/live/${encodeURIComponent(j.id)}?token=${encodeURIComponent(token)}">QB-${esc(j.short_code)}</a>
      ${statusPill(j.status)}
      <span class="muted">${esc(j.event.headcount)} guests · ${esc(j.event.date)} · created ${time(j.created_at)}</span></li>`,
  );
  return `<header class="job"><h1>Recent jobs</h1></header><ul class="jobs">${rows.join("")}</ul>`;
}

/**
 * Full HTML document. The inline script (allowed by the CSP nonce) shows times
 * in the viewer's zone and re-fetches the fragment every 3 seconds.
 */
export function renderPage(opts: { title: string; body: string; nonce: string; refreshUrl: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(opts.title)}</title>
<style nonce="${esc(opts.nonce)}">${CSS}</style>
</head>
<body>
<div class="top"><span class="brand">Quote Broker</span><span class="muted">Live view · read only · simulated vendors · Stripe test mode</span></div>
<main id="live">${opts.body}</main>
<script nonce="${esc(opts.nonce)}">${clientScript(opts.refreshUrl)}</script>
</body>
</html>`;
}

function clientScript(refreshUrl: string): string {
  return `
const fmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
function localTimes() {
  for (const t of document.querySelectorAll("time[datetime]")) {
    const d = new Date(t.getAttribute("datetime"));
    if (!isNaN(d)) t.textContent = fmt.format(d);
  }
}
localTimes();
const url = ${JSON.stringify(refreshUrl).replace(/</g, "\\u003c")};
setInterval(async () => {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) { document.getElementById("live").innerHTML = await res.text(); localTimes(); }
  } catch {}
}, 3000);`;
}

const CSS = `
:root {
  --bg: #f6f5f1; --panel: #ffffff; --ink: #1d1d1b; --muted: #6b6a64; --line: #e3e1da;
  --accent: #1f6f4a; --accent-soft: #e3f1e9; --warn: #a1432b; --warn-soft: #f8e6e0; --wait: #8a6a12; --wait-soft: #f6efd8;
  --out: #eef2f8; --in: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141413; --panel: #1d1d1b; --ink: #ecebe6; --muted: #9c9a92; --line: #33322e;
    --accent: #6cc79a; --accent-soft: #1d3a2b; --warn: #ef9a82; --warn-soft: #3d231c; --wait: #e1c46b; --wait-soft: #3a3220;
    --out: #22262e; --in: #1d1d1b;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.top { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; padding: 12px 24px; border-bottom: 1px solid var(--line); }
.brand { font-weight: 700; }
main { max-width: 1240px; margin: 0 auto; padding: 24px; }
h1 { font-size: 28px; margin: 0 0 4px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em; margin: 0 0 12px; display: flex; gap: 8px; align-items: baseline; }
.muted { color: var(--muted); font-weight: 400; text-transform: none; letter-spacing: 0; font-size: 14px; }
.event { margin: 0; color: var(--muted); }
.summary { margin: 8px 0 16px; font-size: 18px; }
.status { font-size: 13px; font-weight: 600; text-transform: capitalize; padding: 3px 10px; border-radius: 999px; background: var(--wait-soft); color: var(--wait); }
.st-ready, .st-approved, .st-paid { background: var(--accent-soft); color: var(--accent); }
.st-payment_failed, .st-cancelled, .st-expired { background: var(--warn-soft); color: var(--warn); }
.steps { list-style: none; display: flex; flex-wrap: wrap; gap: 6px; padding: 0; margin: 0 0 24px; }
.steps li { padding: 6px 12px; border-radius: 6px; font-size: 14px; border: 1px solid var(--line); color: var(--muted); }
.steps li.done { color: var(--accent); border-color: var(--accent-soft); background: var(--accent-soft); }
.steps li.now { color: var(--panel); background: var(--accent); border-color: var(--accent); font-weight: 600; }
.steps li.bad { background: var(--warn); border-color: var(--warn); }
.ended { color: var(--warn); }
.grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 20px; align-items: start; }
@media (max-width: 900px) { .grid { grid-template-columns: 1fr; } main { padding: 16px; } .top { padding: 12px 16px; } }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 18px; margin-bottom: 20px; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
thead th { font-size: 13px; color: var(--muted); font-weight: 600; }
tbody th { font-weight: 600; }
.c { text-align: center; }
tr.best { background: var(--accent-soft); }
.tag { font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 2px 6px; border-radius: 4px; background: var(--accent); color: var(--panel); }
.tag.soft { background: var(--line); color: var(--ink); }
.vs { font-size: 13px; }
.vs-bounced, .vs-send_failed, .vs-no_reply, .vs-declined { color: var(--warn); }
.vs-replied { color: var(--accent); }
.big { font-size: 22px; font-weight: 600; margin: 0 0 8px; }
.pill { font-size: 13px; font-weight: 600; padding: 3px 10px; border-radius: 999px; background: var(--wait-soft); color: var(--wait); }
.pill-approved, .pill-used { background: var(--accent-soft); color: var(--accent); }
.pill-declined, .pill-expired { background: var(--warn-soft); color: var(--warn); }
.inbox { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.msg { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; background: var(--in); }
.msg.out { background: var(--out); }
.meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline; font-size: 14px; }
.kind { font-weight: 700; }
.subject { font-weight: 600; margin-top: 4px; overflow-wrap: anywhere; }
.body { white-space: pre-wrap; overflow-wrap: anywhere; font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin: 6px 0 0; max-height: 260px; overflow-y: auto; }
.files { margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; }
.file { font-size: 13px; padding: 2px 8px; border-radius: 4px; background: var(--line); }
.auth { font-size: 12px; padding: 1px 6px; border-radius: 4px; }
.auth.ok { background: var(--accent-soft); color: var(--accent); }
.auth.warn { background: var(--warn-soft); color: var(--warn); }
.jobs { list-style: none; padding: 0; display: grid; gap: 8px; }
.jobs li { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
a { color: var(--accent); font-weight: 600; }
`;
