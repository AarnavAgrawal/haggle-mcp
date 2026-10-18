// PURE: the RFQ email text. The opening line discloses that the sender is an AI assistant acting on
// behalf of the customer (never a brand); keep it. The sign-off says the same.
// The machine-readable `rfq.json` part is added once its fields are frozen (contract D8).
//
// Adapted from quote-broker@8a68559 src/channels/outreach.ts (Partner). Changes for Haggle v3:
// [HG-<code>] subject tag, replies go to the per-job inbox, a reply-by time, hard requirements
// listed explicitly, and the budget is only revealed when policy says so (default: not shown).

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-10-22" -> "Thursday October 22". Parsed as a calendar date, not a timestamp. */
export function humanDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  return `${WEEKDAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

export interface RfqInput {
  shortCode: string;
  businessName: string;
  what: string;
  quantity?: number;
  unit?: string;
  date?: string; // YYYY-MM-DD; absent = flexible
  time?: string;
  location: string;
  requirements: string[]; // hard requirements, human-readable
  replyBy: Date;
  /** Only when the buyer's policy allows revealing it. */
  budgetHintCents?: number;
  /** Facts the business should know (any kind of request). */
  details?: { label: string; value: string }[];
  /** Custom answers to ask for, by label; replaces the catering default ask (total, delivery, deposit). */
  askLabels?: { label: string; required: boolean }[];
  /** Who the AI assistant acts for: the customer's name, or "a customer" (default). */
  customer?: string;
}

/** "40 people" (people is the default unit), "3 rooms", or null when nothing is counted. */
export function quantityText(quantity: number | undefined, unit: string | undefined): string | null {
  return quantity === undefined ? null : `${quantity} ${unit ?? "people"}`;
}

export function buildRfqEmail(i: RfqInput): { subject: string; bodyText: string } {
  const qty = quantityText(i.quantity, i.unit);
  const subject = [`[HG-${i.shortCode}] Quote request: ${i.what}`, qty, i.date ? humanDate(i.date) : null].filter(Boolean).join(", ");
  const replyBy = `${humanDate(i.replyBy.toISOString().slice(0, 10))} ${String(i.replyBy.getUTCHours()).padStart(2, "0")}:${String(i.replyBy.getUTCMinutes()).padStart(2, "0")} UTC`;
  const people = i.unit === undefined || i.unit === "people";
  const customer = i.customer?.trim() || "a customer";
  const lines = [
    `Hi ${i.businessName},`,
    "",
    `I'm an AI assistant reaching out on behalf of ${customer}. Could you quote the following?`,
    "",
    `- What: ${i.what}`,
    ...(i.date ? [`- Date: ${humanDate(i.date)}${i.time ? ` at ${i.time}` : ""}`] : []),
    ...(i.quantity !== undefined ? [people ? `- People: ${i.quantity}` : `- Quantity: ${qty}`] : []),
    `- Location: ${i.location}`,
    ...(i.details ?? []).map((d) => `- ${d.label}: ${d.value}`),
    ...(i.requirements.length ? ["- Must have:", ...i.requirements.map((r) => `  - ${r}`)] : []),
  ];
  if (i.budgetHintCents !== undefined) lines.push(`- Budget: up to $${(i.budgetHintCents / 100).toFixed(2)} total`);
  if (i.askLabels?.length) {
    lines.push("", `Could you reply by ${replyBy} with:`, ...i.askLabels.map((a) => `- ${a.label}${a.required ? "" : " (if you can)"}`), "", "A PDF or photo is fine.");
  } else {
    lines.push("", `Please reply by ${replyBy} with your total price, what it includes (delivery, tax), any deposit you need, and how you meet each requirement. A PDF quote is fine.`);
  }
  lines.push("", "Thank you!", `AI assistant for ${customer}`);
  return { subject, bodyText: lines.join("\n") };
}
