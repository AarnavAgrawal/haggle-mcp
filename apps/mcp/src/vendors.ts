// The six predefined demo vendors and whether this server may contact each one right now.
//
// Discovery is not permission. A vendor is offered for outreach only when the operator has
// configured its contact (HAGGLE_DEMO_VENDORS, which also authorizes it as a recipient) and its
// channel is enabled and set up. Everything else is reported with the exact blocker and who can
// fix it, before any deal starts. Nothing here contacts anyone.
import type { Channel } from "@haggle/core";

export interface DemoVendor {
  key: string;
  name: string;
  /** The channel this vendor plays in the demo. */
  channel: Channel;
  /** Who plays it, shown so nobody mistakes a demo vendor for a real business. */
  played_by: string;
}

/** The predefined roster (names match the seller personas so the brain's learning lines up). */
export const DEMO_VENDORS: DemoVendor[] = [
  { key: "harbor_table", name: "Harbor Table", channel: "email", played_by: "seller persona mailbox" },
  { key: "sunset_kitchen", name: "Sunset Kitchen", channel: "imessage", played_by: "a teammate's iPhone" },
  { key: "mission_eats", name: "Mission Eats", channel: "phone", played_by: "a teammate answering a Voice AI call" },
  { key: "bay_catering", name: "Bay Catering", channel: "a2a", played_by: "agent-ready seller (A2A)" },
  { key: "golden_grill", name: "Golden Grill", channel: "email", played_by: "seller persona mailbox" },
  { key: "quickquote_deli", name: "QuickQuote Deli", channel: "email", played_by: "seller persona mailbox (scam-bait test)" },
];

export interface VendorContact {
  email?: string;
  phone?: string;
  a2a_card_url?: string;
  channel?: Channel;
  name?: string;
}

export interface RosterEntry extends DemoVendor {
  email?: string;
  phone?: string;
  a2a_card_url?: string;
  simulated: true;
  ready: boolean;
  /** Why it can't be contacted now (absent when ready). */
  blocker?: string;
  /** The exact action that clears the blocker, and who does it. */
  fix?: string;
}

export interface ChannelStatus {
  email: boolean;
  imessage: boolean;
  phone: boolean;
  a2a: boolean;
  /** iMessage handles people must text to connect, e.g. "connect @haggle". */
  connectCommand: string;
  /** E.164 numbers that have connected over iMessage; null = couldn't check. */
  connected: Set<string> | null;
  /** Calls go over Inkbox's shared iMessage line (the callee must have connected too). */
  callsViaSharedLine: boolean;
}

const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * HAGGLE_DEMO_VENDORS: JSON object keyed by vendor key, e.g.
 * {"harbor_table":{"email":"harbor@inkboxmail.com"},"mission_eats":{"phone":"+14155550123"}}.
 * Unknown keys become extra vendors (name required). Bad entries are reported, never guessed.
 */
export function parseVendorConfig(raw: string | undefined): { contacts: Record<string, VendorContact>; errors: string[] } {
  if (!raw?.trim()) return { contacts: {}, errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { contacts: {}, errors: ["HAGGLE_DEMO_VENDORS is not valid JSON"] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { contacts: {}, errors: ["HAGGLE_DEMO_VENDORS must be a JSON object keyed by vendor"] };
  const contacts: Record<string, VendorContact> = {};
  const errors: string[] = [];
  for (const [key, v] of Object.entries(parsed as Record<string, Record<string, unknown>>)) {
    const c: VendorContact = {};
    if (typeof v?.email === "string") EMAIL.test(v.email.trim()) ? (c.email = v.email.trim().toLowerCase()) : errors.push(`${key}: bad email`);
    if (typeof v?.phone === "string") E164.test(v.phone.replace(/[\s().-]/g, "")) ? (c.phone = v.phone.replace(/[\s().-]/g, "")) : errors.push(`${key}: phone must be E.164`);
    if (typeof v?.a2a_card_url === "string") /^https:\/\//.test(v.a2a_card_url) ? (c.a2a_card_url = v.a2a_card_url) : errors.push(`${key}: a2a_card_url must be https`);
    if (typeof v?.channel === "string" && ["email", "phone", "imessage", "a2a"].includes(v.channel)) c.channel = v.channel as Channel;
    if (typeof v?.name === "string" && v.name.trim()) c.name = v.name.trim().slice(0, 120);
    contacts[key] = c;
  }
  return { contacts, errors };
}

/** Every contact the roster authorizes (added to the recipient allowlist by the operator's config). */
export function rosterRecipients(contacts: Record<string, VendorContact>): string[] {
  return Object.values(contacts).flatMap((c) => [c.email, c.phone, c.a2a_card_url].filter((x): x is string => !!x));
}

/** The roster with each vendor's readiness. Pure: callers pass what the runtime knows. */
export function buildRoster(contacts: Record<string, VendorContact>, ch: ChannelStatus): RosterEntry[] {
  return dedupeRoster(rosterEntries(contacts, ch));
}

function rosterEntries(contacts: Record<string, VendorContact>, ch: ChannelStatus): RosterEntry[] {
  const extra = Object.keys(contacts).filter((k) => !DEMO_VENDORS.some((v) => v.key === k) && contacts[k]!.name);
  const base: DemoVendor[] = [
    ...DEMO_VENDORS,
    ...extra.map((k) => ({ key: k, name: contacts[k]!.name!, channel: contacts[k]!.channel ?? (contacts[k]!.email ? "email" : "phone"), played_by: "operator-configured demo vendor" }) as DemoVendor),
  ];
  return base.map((v) => {
    const c = contacts[v.key] ?? {};
    const channel = c.channel ?? v.channel;
    const entry: RosterEntry = { ...v, channel, ...(c.name ? { name: c.name } : {}), ...(c.email ? { email: c.email } : {}), ...(c.phone ? { phone: c.phone } : {}), ...(c.a2a_card_url ? { a2a_card_url: c.a2a_card_url } : {}), simulated: true, ready: false };
    const block = (blocker: string, fix: string) => ({ ...entry, blocker, fix });
    switch (channel) {
      case "email":
        if (!c.email) return block("no mailbox configured for this demo vendor", `Operator: add "${v.key}":{"email":"<same-org Inkbox seller address>"} to HAGGLE_DEMO_VENDORS and redeploy.`);
        if (!ch.email) return block("email outreach is off", "Operator: check the Inkbox buyer identity.");
        return { ...entry, ready: true };
      case "imessage":
        if (!c.phone) return block("no iPhone number configured for this demo vendor", `Operator: add "${v.key}":{"phone":"+1…","channel":"imessage"} to HAGGLE_DEMO_VENDORS and redeploy.`);
        if (!ch.imessage) return block("iMessage outreach is off on this server", "Operator: set HAGGLE_ENABLE_IMESSAGE=true and redeploy.");
        if (!ch.connected) return block("couldn't confirm this number's iMessage connection (Inkbox check failed)", "Retry in a minute; if it persists, check the Inkbox API key.");
        if (!ch.connected.has(c.phone)) return block(`this number hasn't connected over iMessage yet`, `Vendor: text "${ch.connectCommand}" to the Inkbox iMessage line from that iPhone.`);
        return { ...entry, ready: true };
      case "phone":
        if (!c.phone) return block("no phone number configured for this demo vendor", `Operator: add "${v.key}":{"phone":"+1…"} to HAGGLE_DEMO_VENDORS and redeploy (only someone who agreed to take the call).`);
        if (!ch.phone) return block("Voice AI calls are off on this server", "Operator: set HAGGLE_ENABLE_CALLS=true and redeploy (needs the go-ahead for a live call).");
        if (ch.callsViaSharedLine && !ch.connected) return block("couldn't confirm the callee's iMessage connection, which shared-line calls need", "Retry in a minute.");
        if (ch.callsViaSharedLine && ch.connected && !ch.connected.has(c.phone)) return block("calls go over the shared iMessage line and this number hasn't connected", `Vendor: text "${ch.connectCommand}" from that phone first.`);
        return { ...entry, ready: true };
      case "a2a":
        if (!c.a2a_card_url) return block("no Agent Card configured for this demo vendor", `Operator: add "${v.key}":{"a2a_card_url":"https://…/card"} to HAGGLE_DEMO_VENDORS and redeploy.`);
        if (!ch.a2a) return block("A2A outreach is off on this server", "Operator: set HAGGLE_ENABLE_A2A=true and allow the card in the buyer's A2A rules.");
        return { ...entry, ready: true };
    }
  });
}

/** One phone or mailbox plays one vendor per deal: later duplicates are blocked, never sent twice. */
export function dedupeRoster(roster: RosterEntry[]): RosterEntry[] {
  const seen = new Map<string, string>();
  return roster.map((r) => {
    if (!r.ready) return r;
    const key = r.phone ?? r.email ?? r.a2a_card_url ?? r.key;
    const first = seen.get(key);
    if (first) return { ...r, ready: false, blocker: `same contact as ${first} (one contact plays one vendor per deal)`, fix: `Operator: give ${r.name} its own contact in HAGGLE_DEMO_VENDORS, or run it in a separate deal with businesses=[...].` };
    seen.set(key, r.name);
    return r;
  });
}

/** One line per blocked vendor, for the model and the board. */
export function blockerLines(roster: RosterEntry[]): string[] {
  return roster.filter((r) => !r.ready).map((r) => `${r.name} [${r.channel}]: ${r.blocker}. Fix: ${r.fix}`);
}
