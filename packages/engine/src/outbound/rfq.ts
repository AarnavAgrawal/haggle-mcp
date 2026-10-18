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

/** "12:00" -> "12:00 PM"; "18:30" -> "6:30 PM". Anything else is returned as given. */
export function humanTime(hhmm: string): string {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  if (!m) return hhmm;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * The event time as people read it: "Saturday, October 24, 2026 at 12:00 PM", or, when the buyer is
 * flexible, "any day Monday, October 19 – Friday, October 23, 2026 (flexible)".
 */
export function eventWhen(isoDate: string, time?: string, until?: string): string {
  const fmt = (iso: string, year: boolean) => {
    const [y, m, d] = iso.split("-").map(Number);
    const date = new Date(Date.UTC(y!, m! - 1, d!));
    return Number.isNaN(date.getTime()) ? null : `${WEEKDAYS[date.getUTCDay()]}, ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}${year ? `, ${date.getUTCFullYear()}` : ""}`;
  };
  const day = fmt(isoDate, true);
  if (!day) return isoDate;
  const end = until && until > isoDate ? fmt(until, true) : null;
  const span = end ? `any day ${fmt(isoDate, isoDate.slice(0, 4) !== until!.slice(0, 4))} – ${end} (flexible)` : day;
  return time ? `${span} at ${humanTime(time)}` : span;
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
  quantity?: number; // absent for requests that aren't counted ("fix a leak")
  unit?: string; // "people" (default), "jobs", "hours", "items"
  date?: string; // YYYY-MM-DD; absent = not dated
  date_until?: string; // flexible through this date (YYYY-MM-DD)
  time?: string; // "12:00" (24h, local)
  location: string; // the area ("San Francisco, CA"), or a full place when no venue is given
  /** Delivery address or place; shown first (eventPlace), with the area appended when it doesn't name it. */
  venue?: string;
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
    ...(i.date ? [`- When: ${eventWhen(i.date, i.time, i.date_until)}${i.date_until && i.date_until > i.date ? ". Please tell us which of these days you can do" : ""}`] : []),
    ...(i.quantity !== undefined ? [people ? `- People: ${i.quantity}` : `- Quantity: ${qty}`] : []),
    `- Location: ${eventPlace(i.location, i.venue)}`,
    ...(i.details ?? []).map((d) => `- ${d.label}: ${d.value}`),
    ...(i.requirements.length ? ["- Must have:", ...i.requirements.map((r) => `  - ${r}`)] : []),
  ];
  if (i.budgetHintCents !== undefined) lines.push(`- Budget: up to $${(i.budgetHintCents / 100).toFixed(2)} total`);
  if (i.askLabels?.length) {
    lines.push("", `Could you reply by ${replyBy} with:`, ...i.askLabels.map((a) => `- ${a.label}${a.required ? "" : " (if you can)"}`), "", "A PDF or photo is fine.");
  } else {
    lines.push("", `Please reply by ${replyBy} with your total price, what it includes (delivery or travel, tax), any deposit you need, and how you meet each requirement. A PDF quote is fine.`);
  }
  lines.push("", "Thank you!", `AI assistant for ${customer}`);
  return { subject, bodyText: lines.join("\n") };
}
