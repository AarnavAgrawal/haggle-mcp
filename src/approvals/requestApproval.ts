// PURE: the approval email the human receives (DESIGN.md §13.1).
import type { EventDetails } from "../db/queries.js";
import { humanDate } from "../channels/outreach.js";

const usd = (cents: number | null) => (cents === null ? "not stated" : `$${(cents / 100).toFixed(2)}`);

export interface ApprovalEmailInput {
  shortCode: string;
  vendorName: string;
  event: EventDetails;
  perHeadCents: number | null;
  totalCents: number | null;
  depositCents: number;
  others: { vendorName: string; perHeadCents: number | null; totalCents: number | null }[];
  code: string;
  expiresAt: Date;
}

/** "Saturday October 17 at 21:10 UTC" */
export function humanExpiry(d: Date): string {
  const iso = d.toISOString();
  return `${humanDate(iso.slice(0, 10))} at ${iso.slice(11, 16)} UTC`;
}

export function buildApprovalEmail(i: ApprovalEmailInput): { subject: string; bodyText: string } {
  const subject = `[QB-${i.shortCode}] Approve ${usd(i.depositCents)} deposit to ${i.vendorName}?`;
  const lines = [
    "Your agent picked a caterer and needs your OK to pay the deposit.",
    "",
    `Vendor: ${i.vendorName}`,
    `Event: ${humanDate(i.event.date)} at ${i.event.time}, ${i.event.headcount} guests`,
    `Price: ${usd(i.perHeadCents)}/person, total ${usd(i.totalCents)}`,
    `Deposit to pay now: ${usd(i.depositCents)}`,
  ];
  if (i.others.length > 0) {
    lines.push("", "Other quotes:");
    for (const o of i.others) lines.push(`- ${o.vendorName}: ${usd(o.perHeadCents)}/person, total ${usd(o.totalCents)}`);
  }
  lines.push(
    "",
    `To approve, reply with: APPROVE ${i.code}`,
    "To decline, reply with: NO",
    "",
    `This request expires ${humanExpiry(i.expiresAt)}.`,
  );
  return { subject, bodyText: lines.join("\n") };
}
