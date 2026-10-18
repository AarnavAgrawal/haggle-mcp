// PURE: the RFQ email text. The opening line discloses that the sender is an AI agent; keep it.
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

/** "12:00" -> "12:00 PM"; "18:30" -> "6:30 PM". Anything else is returned as given. */
export function humanTime(hhmm: string): string {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  if (!m) return hhmm;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

/** The exact event time as people read it: "Saturday, October 24, 2026 at 12:00 PM". */
export function eventWhen(isoDate: string, time?: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  if (Number.isNaN(date.getTime())) return isoDate;
  const day = `${WEEKDAYS[date.getUTCDay()]}, ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
  return time ? `${day} at ${humanTime(time)}` : day;
}

/** "Y Combinator office, San Francisco, CA" (venue first when given, area otherwise). */
export function eventPlace(area: string, venue?: string): string {
  if (!venue) return area;
  return venue.toLowerCase().includes(area.split(",")[0]!.trim().toLowerCase()) ? venue : `${venue}, ${area}`;
}

export interface RfqInput {
  shortCode: string;
  businessName: string;
  what: string;
  quantity: number;
  date: string; // YYYY-MM-DD
  time?: string; // "12:00" (24h, local)
  unit?: string; // "people" (default), "jobs", "hours", "items"
  location: string;
  requirements: string[]; // hard requirements, human-readable
  replyBy: Date;
  /** Only when the buyer's policy allows revealing it. */
  budgetHintCents?: number;
}

export function buildRfqEmail(i: RfqInput): { subject: string; bodyText: string } {
  const subject = `[HG-${i.shortCode}] Quote request: ${i.what}, ${i.quantity} ${i.unit ?? "people"}, ${humanDate(i.date)}`;
  const replyBy = `${humanDate(i.replyBy.toISOString().slice(0, 10))} ${String(i.replyBy.getUTCHours()).padStart(2, "0")}:${String(i.replyBy.getUTCMinutes()).padStart(2, "0")} UTC`;
  const lines = [
    `Hi ${i.businessName},`,
    "",
    "I'm an AI assistant arranging this order for a client. Could you quote the following?",
    "",
    `- What: ${i.what}`,
    `- When: ${eventWhen(i.date, i.time)}`,
    !i.unit || i.unit === "people" ? `- People: ${i.quantity}` : `- Quantity: ${i.quantity} ${i.unit}`,
    `- Location: ${i.location}`,
    ...(i.requirements.length ? ["- Must have:", ...i.requirements.map((r) => `  - ${r}`)] : []),
  ];
  if (i.budgetHintCents !== undefined) lines.push(`- Budget: up to $${(i.budgetHintCents / 100).toFixed(2)} total`);
  lines.push(
    "",
    `Please reply by ${replyBy} with your total price, what it includes (delivery or travel, tax), any deposit you need, and how you meet each requirement. A PDF quote is fine.`,
    "",
    "Thank you!",
  );
  return { subject, bodyText: lines.join("\n") };
}
