// Reply layouts of common mail clients (WS-F), written from how each client's plain-text part
// looks: Gmail ("On ... wrote:" + "> " lines, sometimes wrapped), Outlook desktop (a From/Sent/To/
// Subject header block with the original NOT prefixed by ">"), Outlook with its "____" rule,
// Outlook mobile, iOS Mail ("Sent from my iPhone"), Apple Mail, Yahoo (indented attribution, no
// ">"), and bottom-posting. They are approximations for the simulated corpus, not captured mail.
import type { ClientStyle } from "./types.ts";

export interface QuoteMeta {
  /** Who the vendor is replying to (Haggle's mailbox). */
  ourName: string;
  ourAddress: string;
  vendorAddress: string;
  subject: string;
  /** When the quoted message was sent. */
  sentAt: Date;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const two = (n: number) => String(n).padStart(2, "0");
const hour12 = (d: Date) => `${((d.getUTCHours() + 11) % 12) + 1}:${two(d.getUTCMinutes())} ${d.getUTCHours() < 12 ? "AM" : "PM"}`;
const prefixed = (text: string, p = "> ") => text.split("\n").map((l) => (l ? `${p}${l}` : p.trimEnd())).join("\n");

/** The full plain-text body a vendor's client sends: its own words plus the quoted message. */
export function layoutReply(style: ClientStyle, own: string, quoted: string | null, m: QuoteMeta): string {
  const d = m.sentAt;
  const short = `${DAYS[d.getUTCDay()]!.slice(0, 3)}, ${MONTHS[d.getUTCMonth()]!.slice(0, 3)} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  if (quoted === null || style === "plain") return own;
  switch (style) {
    case "gmail":
      return `${own}\n\nOn ${short} at ${hour12(d)} ${m.ourName} <${m.ourAddress}> wrote:\n\n${prefixed(quoted)}\n`;
    case "gmail_wrapped": // Gmail hard-wraps a long attribution line in the text/plain part
      return `${own}\n\nOn ${short} at ${hour12(d)} ${m.ourName} <\n${m.ourAddress}> wrote:\n\n${prefixed(quoted)}\n`;
    case "gmail_fr":
      return `${own}\n\nLe mar. ${d.getUTCDate()} oct. ${d.getUTCFullYear()} à ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}, ${m.ourName} <${m.ourAddress}> a écrit :\n\n${prefixed(quoted)}\n`;
    case "outlook_header": // Outlook desktop: header block, original not prefixed, no separator line
      return `${own}\n\nFrom: ${m.ourName} <${m.ourAddress}>\nSent: ${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${hour12(d)}\nTo: ${m.vendorAddress}\nSubject: ${m.subject}\n\n${quoted}\n`;
    case "outlook_rule":
      return `${own}\n\n________________________________\nFrom: ${m.ourName} <${m.ourAddress}>\nSent: ${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${hour12(d)}\nTo: ${m.vendorAddress}\nSubject: ${m.subject}\n\n${quoted}\n`;
    case "outlook_mobile":
      return `${own}\n\nGet Outlook for iOS<https://aka.ms/o0ukef>\n________________________________\nFrom: ${m.ourName} <${m.ourAddress}>\nSent: ${short} ${hour12(d)}\nTo: ${m.vendorAddress}\nSubject: ${m.subject}\n\n${quoted}\n`;
    case "ios_mail":
      return `${own}\n\nSent from my iPhone\n\n> On ${MONTHS[d.getUTCMonth()]!.slice(0, 3)} ${d.getUTCDate()}, ${d.getUTCFullYear()}, at ${hour12(d)}, ${m.ourName} <${m.ourAddress}> wrote:\n> \n${prefixed(quoted)}\n`;
    case "apple_mail":
      return `${own}\n\n> On ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]!.slice(0, 3)} ${d.getUTCFullYear()}, at ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}, ${m.ourName} <${m.ourAddress}> wrote:\n> \n${prefixed(quoted)}\n`;
    case "yahoo": // attribution indented, original indented but not ">"-prefixed
      return `${own}\n\n    On ${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} at ${hour12(d)}, ${m.ourName} <${m.ourAddress}> wrote:\n\n${prefixed(quoted, "    ")}\n`;
    case "bottom_post":
      return `On ${short} at ${hour12(d)} ${m.ourName} <${m.ourAddress}> wrote:\n${prefixed(quoted)}\n\n${own}\n`;
  }
}
