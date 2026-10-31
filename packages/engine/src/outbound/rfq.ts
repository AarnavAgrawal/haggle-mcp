// PURE: the RFQ email text. One short paragraph and two asks, signed with the customer's name (the
// workspace's or the request's "Customer" detail; never an invented person, never a brand). Email
// carries no AI self-label (CLAUDE.md section 7): if a business asks, the answer is truthful. Calls and
// texts still say they are an AI assistant. No attachment: the machine-readable RFQ goes only to A2A
// businesses.
//
// Adapted from quote-broker@8a68559 src/channels/outreach.ts (Partner). Changes for Haggle v5:
// a plain subject (no reference code), a local reply-by day, the must-haves in the same paragraph,
// and the budget only revealed when policy says so (default: not shown).
import { firstEmailAsks } from "../intake/intake.ts";
import { DEFAULT_CONTACT_TIMEZONE } from "../workflow/contactWindow.ts";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-22" as a calendar date (UTC midnight), or null. */
const calendar = (iso: string): Date | null => {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  return Number.isNaN(date.getTime()) ? null : date;
};

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
    const date = calendar(iso);
    return date ? `${WEEKDAYS[date.getUTCDay()]}, ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}${year ? `, ${date.getUTCFullYear()}` : ""}` : null;
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
  /** The IANA time zone the reply-by day is said in (the workspace's); default America/Los_Angeles. */
  timezone?: string;
  /** Now, to say "by 3:00 PM today" instead of a weekday when the reply-by is today. */
  now?: Date;
  /** Only when the buyer's policy allows revealing it. */
  budgetHintCents?: number;
  /** Facts the business should know (any kind of request). */
  details?: { label: string; value: string }[];
  /** Custom answers to ask for, by label; they replace the all-in price ask. */
  askLabels?: { label: string; required: boolean }[];
  /** Who the email is from: the customer's name. Unknown ("a customer" or empty) signs "Thanks!". */
  customer?: string;
}

/** "40 people" (people is the default unit), "3 rooms", or null when nothing is counted. */
export function quantityText(quantity: number | undefined, unit: string | undefined): string | null {
  return quantity === undefined ? null : `${quantity} ${unit ?? "people"}`;
}

/** A request that starts with a verb ("fix a leak") reads as "Quote request: fix a leak". */
const VERB_FIRST = /^(fix|repair|install|replace|clean|move|haul|print|paint|remove|build|deliver|rent|hire|book|service|inspect|unclog|mount|assemble|set up|design|get|need)\b/i;

/**
 * "Quote for lunch for 40 – Thu Nov 12" (people are the default unit), "Quote for chairs for 100 items",
 * "Quote request: fix a leaking pipe". No reference code: replies are matched by the thread and
 * Haggle's own Message-IDs (inbound/matching.ts). Every later email to the business on the deal reuses
 * this subject, so it threads with the RFQ.
 */
export function quoteRequestSubject(r: { what: string; quantity?: number; unit?: string; date?: string }): string {
  const what = r.what.trim();
  const people = r.unit === undefined || r.unit === "people";
  const qty = r.quantity === undefined ? "" : ` for ${r.quantity}${people ? "" : ` ${r.unit}`}`;
  const d = r.date ? calendar(r.date) : null;
  const when = d ? ` – ${SHORT_WEEKDAYS[d.getUTCDay()]} ${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` : "";
  return `${VERB_FIRST.test(what) ? `Quote request: ${what}` : `Quote for ${what}`}${qty}${when}`;
}

/** "Thursday, Nov 12" (with the year only when it isn't `year`). */
function dayText(iso: string, year?: number): string {
  const d = calendar(iso);
  if (!d) return iso;
  return `${WEEKDAYS[d.getUTCDay()]}, ${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${year !== undefined && d.getUTCFullYear() !== year ? `, ${d.getUTCFullYear()}` : ""}`;
}

/** The reply-by in the workspace's time zone: "by Tuesday, Nov 10", or "by 3:00 PM today". Never UTC. */
export function replyByText(replyBy: Date, timezone: string = DEFAULT_CONTACT_TIMEZONE, now?: Date): string {
  let tz = timezone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = DEFAULT_CONTACT_TIMEZONE;
  }
  const ymd = (t: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  if (now && ymd(now) === ymd(replyBy)) return `by ${new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(replyBy)} today`;
  return `by ${dayText(ymd(replyBy))}`;
}

/** The name an email is signed with, or null when the customer isn't named. */
export function signatureName(customer: string | undefined | null): string | null {
  const c = customer?.trim();
  return c && c.toLowerCase() !== "a customer" ? c : null;
}

/** The sign-off on every email to a business: "Thanks,\nAcme Labs", or "Thanks!" when the customer isn't named. */
export function emailSignOff(customer: string | undefined | null): string {
  const name = signatureName(customer);
  return name ? `Thanks,\n${name}` : "Thanks!";
}

/** "Earliest date" -> "earliest date" mid-sentence ("AV setup" keeps its case). */
export const lowerFirst = (s: string): string => s.replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase());

/** "a, b and c", each lowercased at the start for use mid-sentence. */
export const listText = (xs: string[]): string => {
  const ys = xs.map(lowerFirst);
  return ys.length <= 1 ? ys.join("") : `${ys.slice(0, -1).join(", ")} and ${ys.at(-1)}`;
};
/**
 * The follow-up ask in one sentence: "Could you also tell us your cancellation policy?", or with
 * several (they mix requirements and terms) "Could you also tell us: delivery included; your
 * cancellation policy?".
 */
export function alsoAsk(xs: string[]): string {
  const ys = xs.map((x) => lowerFirst(x.trim().replace(/[?.]+$/, ""))).filter(Boolean);
  return ys.length <= 1 ? `Could you also tell us ${ys.join("")}?` : `Could you also tell us: ${ys.join("; ")}?`;
}

const bare = (s: string) => s.trim().replace(/[.\s]+$/, "");

export function buildRfqEmail(i: RfqInput): { subject: string; bodyText: string } {
  const subject = quoteRequestSubject(i);
  const year = i.replyBy.getUTCFullYear();
  const people = i.unit === undefined || i.unit === "people";
  const flexible = !!(i.date && i.date_until && i.date_until > i.date);
  const at = i.time ? ` at ${humanTime(i.time)}` : "";
  const when = !i.date ? "" : flexible ? ` on any day from ${dayText(i.date, year)} to ${dayText(i.date_until!, year)}${at}` : ` on ${dayText(i.date, year)}${at}`;
  const qty = i.quantity === undefined ? "" : ` for ${i.quantity} ${people ? "people" : i.unit}`;
  const place = eventPlace(i.location, i.venue);
  const { allIn, asks, delivered } = firstEmailAsks({ what: i.what, quantity: i.quantity, unit: i.unit, date: i.date, date_until: i.date_until, time: i.time, details: i.details, ask: i.askLabels?.map((a) => ({ key: a.label, label: a.label })) });
  const where = delivered ? (i.venue ? `, delivered to ${place}` : `, for delivery in ${place}`) : i.venue ? ` at ${place}` : ` in ${place}`;
  // "At least 12 vegetarian meals" reads "We need at least 12 ..." (an acronym like "AV" keeps its case).
  const musts = i.requirements.map(bare).filter(Boolean).map(lowerFirst);
  const what = bare(i.what);
  const facts = [
    `${VERB_FIRST.test(what) ? `Could you give us a quote to ${what}` : `Could you quote ${what}`}${qty}${when}${where}?`,
    // "We need 12 vegetarian meals." reads naturally for a count; "Must-have: licensed and insured." otherwise.
    ...(musts.length === 1 ? [/^(\d|at least|at most|an? |no |some |one |two |three )/i.test(musts[0]!) ? `We need ${musts[0]}.` : `Must-have: ${musts[0]}.`] : musts.length ? [`Must-haves: ${musts.join("; ")}.`] : []),
    ...(i.details?.length ? [`Details: ${i.details.map((d) => `${d.label}: ${bare(d.value)}`).join("; ")}.`] : []),
    ...(i.budgetHintCents !== undefined ? [`Our budget is up to $${(i.budgetHintCents / 100).toFixed(2)} total.`] : []),
  ];
  // The asks: the all-in price (or the request's own answers) and any deposit, plus at most two short
  // ones (intake.firstEmailAsks). Everything else is asked in a follow-up, only if the reply leaves it out.
  const wants = i.askLabels?.length
    ? [...i.askLabels.map((a) => `${a.label}${a.required ? "" : " (if you can)"}`), ...asks]
    : [`your all-in price (${allIn})`, ...asks];
  const lines = [
    `Hi ${i.businessName},`,
    "",
    facts.join(" "),
    "",
    `If you can do it, please reply ${replyByText(i.replyBy, i.timezone, i.now)} with ${listText(wants)}. A photo or PDF of your quote is fine.`,
    "",
    emailSignOff(i.customer),
  ];
  return { subject, bodyText: lines.join("\n") };
}
