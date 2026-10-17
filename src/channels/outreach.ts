// PURE: the outreach email (DESIGN.md §10.3). The opening line discloses that
// the sender is an AI agent; keep it.
import type { EventDetails } from "../db/queries.js";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-10-24" -> "Saturday October 24". Parsed as a calendar date, not a timestamp. */
export function humanDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  return `${WEEKDAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

export function dietarySummary(dietary: EventDetails["dietary"]): string {
  if (dietary.length === 0) return "none";
  return dietary.map((d) => `${d.count} ${d.need}`).join(", ");
}

export function buildOutreach(opts: {
  shortCode: string;
  vendorName: string;
  event: EventDetails;
  budgetPerHeadCents: number | null;
}): { subject: string; bodyText: string } {
  const { event } = opts;
  const subject = `[QB-${opts.shortCode}] Catering quote request: ${event.headcount} guests, ${humanDate(event.date)}`;

  const lines = [
    `Hi ${opts.vendorName},`,
    "",
    "I'm an AI assistant arranging catering for a client. Could you quote the following?",
    "",
    `- Date and time: ${humanDate(event.date)} at ${event.time}`,
    `- Guests: ${event.headcount}`,
    `- Location: ${event.location}`,
    `- Dietary needs: ${dietarySummary(event.dietary)}`,
    `- Cuisine: ${event.cuisine ?? "open to your suggestions"}`,
  ];
  if (opts.budgetPerHeadCents !== null) {
    lines.push(`- Budget: about $${(opts.budgetPerHeadCents / 100).toFixed(2)}/person`);
  }
  if (event.notes) lines.push(`- Notes: ${event.notes}`);
  lines.push(
    "",
    "Please reply with your price per person, any delivery fee, the deposit you need, and a sample menu. A PDF menu is fine.",
    "",
    "Thank you!",
  );

  return { subject, bodyText: lines.join("\n") };
}
