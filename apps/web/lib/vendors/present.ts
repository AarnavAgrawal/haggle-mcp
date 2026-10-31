// How the vendors page words and formats a vendor: channel and consent in plain words, a contact
// formatted for reading, today's opening hours from the stored weekly hours, and the optimistic list
// updates (add, remove) the page shows while the refreshed list loads. Pure; no I/O.
import type { ConsentBasis } from "./form.ts";
import type { VendorView } from "./types.ts";

const CHANNEL: Record<string, string> = { email: "Email", phone: "Phone call", imessage: "Text", a2a: "Agent" };
/** "Email", "Phone call", "Text", "Agent"; an unknown code reads as "Other". */
export const channelLabel = (channel: string) => CHANNEL[channel] ?? "Other";

const BASIS: Record<ConsentBasis | "operator_recorded", string> = {
  existing_relationship: "You already work with them",
  business_agreed: "They agreed to be contacted",
  public_listing_email: "Public listing, email only",
  operator_recorded: "Recorded by your admin",
};
/** The consent a vendor rests on, in a few plain words (the table's column). */
export const basisLabel = (basis: string) => BASIS[basis as keyof typeof BASIS] ?? "Recorded";

/**
 * A contact as people read it: a US/Canada number as "(415) 555-0123"; other numbers (no numbering
 * plan to group them by) and emails as stored.
 */
export function displayContact(contact: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(contact);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : contact;
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const dayIndex = (token: string) => DAYS.indexOf(token.slice(0, 3).toLowerCase());
const LINE = /^\s*(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?(?:\s*[-–]\s*(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?)?\s*:?\s*(.+)$/i;

/** "09:00" -> "9 AM", "17:30" -> "5:30 PM", "24:00" -> "midnight"; anything else unchanged. */
export function clockWords(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return hhmm.trim();
  const h = Number(m[1]) % 24;
  const min = Number(m[2]);
  if (h === 0 && min === 0 && Number(m[1]) === 24) return "midnight";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}${min ? `:${m[2]}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

/** "09:00–17:00" -> "9 AM–5 PM"; other text (e.g. "open 24 hours", "Closed") as written. */
export function hoursWords(range: string): string {
  const parts = range.split(/\s*[-–]\s*/);
  if (parts.length === 2 && parts.every((p) => /^\d{1,2}:\d{2}$/.test(p))) return `${clockWords(parts[0]!)}–${clockWords(parts[1]!)}`;
  const t = range.trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}

/**
 * Today's hours from a vendor's stored weekly lines ("Mon 09:00–17:00", "Mon-Fri: 09:00 - 17:00").
 * Several intervals on one day are joined with ", ". "Closed today" when every line names its days and
 * none covers today; null when the hours are unknown or can't be read.
 */
export function hoursToday(lines: string[] | undefined, now: Date = new Date()): string | null {
  if (!lines?.length) return null;
  const today = now.getDay();
  const hits: string[] = [];
  let readable = 0;
  for (const line of lines) {
    const m = LINE.exec(line);
    if (!m) continue;
    readable++;
    const from = dayIndex(m[1]!);
    const to = m[2] ? dayIndex(m[2]) : from;
    const covers = from <= to ? today >= from && today <= to : today >= from || today <= to;
    if (covers) hits.push(hoursWords(m[3]!));
  }
  if (hits.length) return hits.join(", ");
  return readable === lines.length ? "Closed today" : null;
}

const CONSENT = /^(existing_relationship|business_agreed|public_listing_email)(?::\s*([\s\S]*?))?\s*\(attested by \S+ at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)\)\s*$/;

/**
 * The recorded consent in readable parts. Consent added here is stored as
 * `<basis>: <note> (attested by web:<actor> at <ISO time>)` (apps/mcp/src/service/vendors.ts): that
 * becomes the note and when it was confirmed, without the internal actor id. Anything else (an
 * operator's free-form record) is shown as written.
 */
export function consentParts(text: string): { note: string | null; confirmedAt: string | null; raw: string | null } {
  const m = CONSENT.exec(text.trim());
  if (!m) return { note: null, confirmedAt: null, raw: text.trim() || null };
  return { note: m[2]?.trim() || null, confirmedAt: m[3]!, raw: null };
}

/** An optimistic change to the vendor list while the refreshed list loads. */
export type VendorChange = { type: "add"; vendor: VendorView } | { type: "remove"; contact: string };

/**
 * Apply one optimistic change. An added vendor goes last, where the server lists it (oldest first), or
 * replaces the one with the same contact in place; a removed one disappears.
 */
export function applyVendorChange(list: VendorView[], change: VendorChange): VendorView[] {
  if (change.type === "remove") return list.filter((v) => v.contact !== change.contact);
  const at = list.findIndex((v) => v.contact === change.vendor.contact);
  return at < 0 ? [...list, change.vendor] : list.map((v, i) => (i === at ? change.vendor : v));
}

/** Business names compared loosely ("Bay Catering, Inc." ~ "bay catering inc"), for "already a vendor". */
export const canonName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * What a search that found nothing tells the buyer, by the discover tool's public_discovery.status.
 * The server's own message is operator-facing (it names env keys) and is shown only for a status this
 * page doesn't know. `next`: the one action that helps (add a known business, name an area, retry).
 */
export function searchOutcome(status: string, serverMessage: string, asked: { category: string; area: string }): { title: string; body: string; next: "add" | "area" | "retry" | null } {
  const where = asked.area ? ` near ${asked.area}` : "";
  switch (status) {
    case "ok":
      return { title: `Nothing found for ${asked.category}${where}.`, body: "Try a broader kind of business, or a nearby city.", next: null };
    case "no_area":
      return { title: "Where should Haggle look?", body: "Add a city or neighborhood to search near.", next: "area" };
    case "rate_limited":
      return { title: "Too many searches just now.", body: "Try again in a minute.", next: "retry" };
    case "unavailable":
      return { title: "The business listings didn't answer.", body: "Try again in a moment.", next: "retry" };
    case "not_configured":
    case "key_rejected":
      return { title: "Business search isn't available on this Haggle server.", body: "You can still add a business you already use.", next: "add" };
    default:
      return { title: `Nothing found for ${asked.category}${where}.`, body: serverMessage || "Try a broader kind of business, or a nearby city.", next: null };
  }
}
