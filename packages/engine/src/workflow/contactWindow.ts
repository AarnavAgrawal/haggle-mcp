// PURE: when Haggle may contact a business unprompted (the first RFQ, a reminder to a business that
// hasn't answered). Real vendors are small businesses: an RFQ at 23:00 or three reminders in an
// afternoon is spam. Default: Mon–Sat 08:00–19:00 in the workspace's timezone (America/Los_Angeles),
// a first reminder no sooner than 24 business hours after the last message, at most 2 reminders,
// never to a suppressed or opted-out contact, never once the job has closed or its reply-by passed.
//
// What is NOT gated here: Haggle answering the business's own message (a missing-info follow-up,
// the answer to its question, a counteroffer reply in a live conversation). Those respond to the
// business, which just wrote. Calls keep their own call hours and cooldown (callPolicy.ts).
//
// An RFQ that would be deferred past the point where the business could still answer by the
// request's reply-by goes out at once, and the reason is recorded (decideFirstContact "deadline").
// Times are wall-clock in the timezone, so DST changes move the UTC instant, never the local hour.

export interface ContactWindowConfig {
  /** IANA timezone; the workspace's when omitted. */
  timezone?: string;
  /** Local weekdays contact is allowed: 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** Local minutes after midnight, [start, end). */
  startMinute: number;
  endMinute: number;
  /** A business needs at least this long inside the window to answer before the reply-by; otherwise the RFQ goes now. */
  minReplyMs: number;
  /** First reminder: no sooner than this many business hours after the last message to the business. */
  firstFollowUpBusinessHours: number;
  /** Between reminders. */
  followUpGapBusinessHours: number;
  /** Reminders to a business that hasn't answered, per job. */
  maxFollowUps: number;
}

export const DEFAULT_CONTACT_TIMEZONE = "America/Los_Angeles";

export const DEFAULT_CONTACT_WINDOW: ContactWindowConfig = {
  days: [1, 2, 3, 4, 5, 6], startMinute: 8 * 60, endMinute: 19 * 60, minReplyMs: 2 * 3_600_000,
  firstFollowUpBusinessHours: 24, followUpGapBusinessHours: 24, maxFollowUps: 2,
};

const MIN = 60_000;
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Local calendar parts of an instant in a timezone. */
export function localParts(t: Date, timezone: string): { y: number; m: number; d: number; weekday: number; minute: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), weekday: DAY_NAMES.indexOf(String(p.weekday).toLowerCase().slice(0, 3)), minute: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

/** The UTC offset (ms) of a timezone at an instant. */
function offsetMs(t: Date, timezone: string): number {
  const p = localParts(t, timezone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, Math.floor(p.minute / 60), p.minute % 60);
  return asUtc - Math.floor(t.getTime() / MIN) * MIN;
}

/** The instant of a local wall-clock time (a time in a DST gap resolves forward). */
export function zonedInstant(y: number, m: number, d: number, minute: number, timezone: string): Date {
  const wall = Date.UTC(y, m - 1, d, Math.floor(minute / 60), minute % 60);
  let t = wall - offsetMs(new Date(wall), timezone);
  t = wall - offsetMs(new Date(t), timezone);
  return new Date(t);
}

export function isOpen(t: Date, cfg: ContactWindowConfig, timezone: string): boolean {
  const p = localParts(t, timezone);
  return cfg.days.includes(p.weekday) && p.minute >= cfg.startMinute && p.minute < cfg.endMinute;
}

/** The local calendar day `offset` days after `t`'s local day. */
function dayAfter(t: Date, offset: number, timezone: string) {
  const p = localParts(t, timezone);
  const c = new Date(Date.UTC(p.y, p.m - 1, p.d + offset));
  return { y: c.getUTCFullYear(), m: c.getUTCMonth() + 1, d: c.getUTCDate(), weekday: c.getUTCDay() };
}

/** `t` when the window is open, else the next opening. Null when the window never opens (no days). */
export function nextOpen(t: Date, cfg: ContactWindowConfig, timezone: string): Date | null {
  if (!cfg.days.length || cfg.startMinute >= cfg.endMinute) return null;
  if (isOpen(t, cfg, timezone)) return t;
  for (let i = 0; i <= 8; i++) {
    const day = dayAfter(t, i, timezone);
    if (!cfg.days.includes(day.weekday)) continue;
    const start = zonedInstant(day.y, day.m, day.d, cfg.startMinute, timezone);
    if (start.getTime() > t.getTime()) return start;
  }
  return null;
}

/** When the window that is open at `t` closes. */
function closeOf(t: Date, cfg: ContactWindowConfig, timezone: string): Date {
  const p = localParts(t, timezone);
  return zonedInstant(p.y, p.m, p.d, cfg.endMinute, timezone);
}

/** `start` plus `hours` counted only inside the window (24 business hours = about 2 days at 08–19). */
export function addBusinessHours(start: Date, hours: number, cfg: ContactWindowConfig, timezone: string): Date | null {
  let left = hours * 60 * MIN;
  let t: Date | null = start;
  for (let i = 0; i < 400 && t; i++) {
    t = nextOpen(t, cfg, timezone);
    if (!t) return null;
    const end = closeOf(t, cfg, timezone);
    const avail = end.getTime() - t.getTime();
    if (left <= avail) return new Date(t.getTime() + left);
    left -= avail;
    t = end;
  }
  return null;
}

/** Window time between two instants (ms), for "can the business still answer before the reply-by". */
export function businessMsBetween(from: Date, to: Date, cfg: ContactWindowConfig, timezone: string): number {
  let total = 0;
  let t: Date | null = from;
  for (let i = 0; i < 400 && t && t < to; i++) {
    t = nextOpen(t, cfg, timezone);
    if (!t || t >= to) break;
    const end = closeOf(t, cfg, timezone);
    total += Math.min(end.getTime(), to.getTime()) - t.getTime();
    t = end;
  }
  return total;
}

export type FirstContactDecision =
  | { send: true; reason: "in_window" }
  /** Outside the window, but deferring would leave the business too little time before the reply-by. */
  | { send: true; reason: "deadline"; nextOpen: Date | null; note: string }
  | { send: false; reason: "outside_window"; until: Date };

/**
 * The first RFQ to a business. Inside the window: now. Outside it: at the next opening, unless the
 * business would then have less than `minReplyMs` of window time before `deadline` (the reply-by),
 * in which case it goes now and `note` says why.
 */
export function decideFirstContact(now: Date, deadline: Date | null, cfg: ContactWindowConfig, timezone: string): FirstContactDecision {
  if (isOpen(now, cfg, timezone)) return { send: true, reason: "in_window" };
  const next = nextOpen(now, cfg, timezone);
  const enough = next !== null && (deadline === null || businessMsBetween(next, deadline, cfg, timezone) >= cfg.minReplyMs);
  if (!enough) {
    return { send: true, reason: "deadline", nextOpen: next, note: next ? `sent outside contact hours: the next opening (${next.toISOString()}) leaves too little time before the reply-by (${deadline!.toISOString()})` : "sent outside contact hours: no contact window is configured to open" };
  }
  return { send: false, reason: "outside_window", until: next! };
}

export type FollowUpDecision =
  | { send: true }
  | { send: false; reason: "too_soon" | "outside_window"; until: Date }
  | { send: false; reason: "suppressed" | "opted_out" | "job_closed" | "replied" | "max_reached" | "past_deadline" | "no_window"; until: null };

/**
 * A reminder to a business that hasn't answered: never after a suppression, an opt-out, a reply,
 * the job closing or its reply-by; at most `maxFollowUps`; spaced in business hours from the last
 * message Haggle sent it; only inside the window.
 */
export function decideFollowUp(i: {
  now: Date; lastSentAt: Date; followUpsSent: number; suppressed: boolean; optedOut: boolean; jobOpen: boolean; replied: boolean; deadline: Date | null;
}, cfg: ContactWindowConfig, timezone: string): FollowUpDecision {
  const never = (reason: Extract<FollowUpDecision, { until: null }>["reason"]): FollowUpDecision => ({ send: false, reason, until: null });
  if (i.suppressed) return never("suppressed");
  if (i.optedOut) return never("opted_out");
  if (!i.jobOpen) return never("job_closed");
  if (i.replied) return never("replied");
  if (i.followUpsSent >= cfg.maxFollowUps) return never("max_reached");
  if (i.deadline && i.now.getTime() >= i.deadline.getTime()) return never("past_deadline");
  const due = addBusinessHours(i.lastSentAt, i.followUpsSent === 0 ? cfg.firstFollowUpBusinessHours : cfg.followUpGapBusinessHours, cfg, timezone);
  if (!due) return never("no_window");
  if (i.deadline && due.getTime() >= i.deadline.getTime()) return never("past_deadline");
  if (i.now.getTime() < due.getTime()) return { send: false, reason: "too_soon", until: due };
  if (!isOpen(i.now, cfg, timezone)) {
    const n = nextOpen(i.now, cfg, timezone);
    return n ? { send: false, reason: "outside_window", until: n } : never("no_window");
  }
  return { send: true };
}

/**
 * HAGGLE_CONTACT_HOURS="8-19" and HAGGLE_CONTACT_DAYS="mon-sat" (or "mon,tue,…"; "off" disables the
 * window). Anything unparseable falls back to the default, never to "any time".
 */
export function contactWindowFromEnv(env: { HAGGLE_CONTACT_HOURS?: string; HAGGLE_CONTACT_DAYS?: string; HAGGLE_CONTACT_TIMEZONE?: string }): ContactWindowConfig | null {
  if ((env.HAGGLE_CONTACT_HOURS ?? "").trim().toLowerCase() === "off") return null;
  const cfg: ContactWindowConfig = { ...DEFAULT_CONTACT_WINDOW };
  const h = (env.HAGGLE_CONTACT_HOURS ?? "").trim().match(/^(\d{1,2})(?::(\d{2}))?-(\d{1,2})(?::(\d{2}))?$/);
  if (h) {
    const s = Number(h[1]) * 60 + Number(h[2] ?? 0);
    const e = Number(h[3]) * 60 + Number(h[4] ?? 0);
    if (s < e && e <= 24 * 60) Object.assign(cfg, { startMinute: s, endMinute: e });
  }
  const daysRaw = (env.HAGGLE_CONTACT_DAYS ?? "").trim().toLowerCase();
  if (daysRaw) {
    const range = daysRaw.match(/^([a-z]{3})-([a-z]{3})$/);
    let days: number[] = [];
    if (range) {
      const [a, b] = [DAY_NAMES.indexOf(range[1]!), DAY_NAMES.indexOf(range[2]!)];
      if (a >= 0 && b >= 0) for (let d = a; ; d = (d + 1) % 7) { days.push(d); if (d === b || days.length > 7) break; }
    } else {
      days = daysRaw.split(",").map((x) => DAY_NAMES.indexOf(x.trim().slice(0, 3)));
    }
    if (days.length && days.every((d) => d >= 0)) cfg.days = [...new Set(days)].sort();
  }
  const tz = env.HAGGLE_CONTACT_TIMEZONE?.trim();
  if (tz) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      cfg.timezone = tz;
    } catch { /* invalid zone: keep the workspace's */ }
  }
  return cfg;
}

/** "Mon 08:00" in the business's local time, for event lines. */
export function localLabel(t: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(t);
}
