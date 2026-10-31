// PURE: a business's weekly opening hours, from its public listing (Amazon Location `OpeningHours`
// components) or its own website (schema.org JSON-LD `openingHoursSpecification` / `openingHours`),
// and when Haggle may ring or text it: only while it is open, never in the first or last 30 minutes
// of an opening interval, in the business's own timezone. Times are wall-clock in that timezone, so a
// DST change moves the UTC instant, never the local hour. Unknown hours are absent (never invented):
// callers then keep their usual contact window.
import { localParts, zonedInstant } from "../workflow/contactWindow.ts";

/** One opening interval: local weekday (0 = Sunday … 6 = Saturday) and minutes after that day's midnight. */
export interface HoursInterval {
  day: number;
  startMinute: number;
  /** Exclusive; above 1440 when the interval runs past midnight (22:00–02:00 → 1320–1560). */
  endMinute: number;
}

export interface WeeklyHours {
  /** IANA timezone of the hours; null when the source didn't say (website hours): the caller's default applies. */
  timezone: string | null;
  intervals: HoursInterval[];
  /** As the source displays them ("Mon-Fri: 08:30 - 16:00"), else generated. */
  display: string[];
  /** Where they came from: "Amazon Location Service" (listing) or "business website". */
  source: string;
}

/** Calls and texts stay this far from opening and closing time. */
export const CONTACT_MARGIN_MIN = 30;

const DAY = 1440;
const WEEK = 7 * DAY;
const MIN = 60_000;
const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const DAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** True when the zone is a valid IANA name this runtime knows. */
export function validTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** A sane WeeklyHours from untrusted JSON (a stored row, a request body), or null. */
export function asWeeklyHours(v: unknown): WeeklyHours | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const intervals = (Array.isArray(o.intervals) ? o.intervals : []).flatMap((i: unknown): HoursInterval[] => {
    const x = i as Record<string, unknown>;
    const [day, s, e] = [x?.day, x?.startMinute, x?.endMinute];
    return Number.isInteger(day) && Number.isInteger(s) && Number.isInteger(e) && (day as number) >= 0 && (day as number) <= 6 && (s as number) >= 0 && (s as number) < DAY && (e as number) > (s as number) && (e as number) <= 2 * DAY
      ? [{ day: day as number, startMinute: s as number, endMinute: e as number }] : [];
  }).slice(0, 50);
  if (!intervals.length) return null;
  const display = (Array.isArray(o.display) ? o.display : []).filter((d): d is string => typeof d === "string").map((d) => d.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 120)).slice(0, 14);
  return { timezone: validTimezone(o.timezone) ? o.timezone : null, intervals, display: display.length ? display : displayOf(intervals), source: typeof o.source === "string" ? o.source.slice(0, 60) : "unknown" };
}

const hhmm = (m: number) => `${String(Math.floor((m % DAY) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** "Mon 09:00–17:00" lines, one per interval, in week order. */
export function displayOf(intervals: HoursInterval[]): string[] {
  return [...intervals].sort((a, b) => a.day - b.day || a.startMinute - b.startMinute)
    .map((i) => `${DAY_LABEL[i.day]} ${i.startMinute === 0 && i.endMinute === DAY ? "open 24 hours" : `${hhmm(i.startMinute)}–${hhmm(i.endMinute)}`}`);
}

// ───────────────────────────── Amazon Location ─────────────────────────────

export interface AmazonOpeningHours {
  Display?: string[];
  OpenNow?: boolean;
  Components?: { OpenTime?: string; OpenDuration?: string; Recurrence?: string }[];
  Categories?: { Id?: string; Name?: string; Primary?: boolean }[];
}

/** "T083000" (or "20240101T083000") → 510; null when unreadable. */
function openTime(s?: string): number | null {
  const m = /T(\d{2})(\d{2})(\d{2})?/.exec(s ?? "");
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v < DAY ? v : null;
}

/** "PT07H30M" → 450, "P1D" → 1440, "PT24H00M" → 1440; null when unreadable or zero. */
function duration(s?: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:\d+S)?)?$/.exec((s ?? "").trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const v = Number(m[1] ?? 0) * DAY + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return v > 0 && v <= DAY ? v : null;
}

/** "FREQ:DAILY;BYDAY:MO,TU" (Amazon's form) or "FREQ=DAILY;BYDAY=MO,TU" → [1, 2]; no BYDAY = every day. */
function recurrenceDays(s?: string): number[] {
  const by = /BYDAY[:=]([A-Z,]+)/i.exec(s ?? "");
  if (!by) return /FREQ[:=]DAILY/i.test(s ?? "") || !s ? [0, 1, 2, 3, 4, 5, 6] : [];
  return [...new Set(by[1]!.toUpperCase().split(",").map((d) => BYDAY.indexOf(d.trim().slice(-2))).filter((d) => d >= 0))];
}

/**
 * A place's opening hours from Amazon Location `OpeningHours`. One building may list several
 * businesses' hours, each tagged with categories: the entry for the place's primary category wins,
 * then an untagged one, then the first.
 */
export function amazonHours(list: AmazonOpeningHours[] | undefined, timezone: string | null, primaryCategory?: string): WeeklyHours | null {
  if (!list?.length) return null;
  const tagged = (h: AmazonOpeningHours) => !!h.Categories?.length;
  const pick = (primaryCategory ? list.find((h) => h.Categories?.some((c) => c.Id === primaryCategory)) : undefined) ?? list.find((h) => !tagged(h)) ?? list[0]!;
  const intervals: HoursInterval[] = [];
  for (const c of pick.Components ?? []) {
    const start = openTime(c.OpenTime);
    const len = duration(c.OpenDuration);
    if (start === null || len === null) continue;
    for (const day of recurrenceDays(c.Recurrence)) intervals.push({ day, startMinute: start, endMinute: start + len });
  }
  if (!intervals.length) return null;
  const display = (pick.Display ?? []).filter((d) => typeof d === "string").slice(0, 14);
  return { timezone: validTimezone(timezone) ? timezone : null, intervals, display: display.length ? display : displayOf(intervals), source: "Amazon Location Service" };
}

// ───────────────────────────── schema.org (the business's website) ─────────────────────────────

const SCHEMA_DAYS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6 };

/** "09:00" / "9:00:00" / "17:30" → minutes; null otherwise. */
function clock(s: unknown): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})(?::\d{2})?/.exec(typeof s === "string" ? s : "");
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v <= DAY ? v : null;
}

/** opens/closes → an interval; a close at or before the open runs past midnight; 00:00–00:00 (or 23:59) is all day. */
function span(day: number, opens: number, closes: number): HoursInterval {
  if (opens === closes || (opens === 0 && closes >= 1439)) return { day, startMinute: 0, endMinute: DAY };
  return { day, startMinute: opens, endMinute: closes > opens ? closes : closes + DAY };
}

function dayName(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const d = SCHEMA_DAYS[v.replace(/^https?:\/\/schema\.org\//i, "").trim().toLowerCase()];
  return d ?? null;
}

/** "Mo-Fr 09:00-17:00", "Mo,We 10:00-14:00", "Sa 10:00-16:00", "Mo-Su" (all day). */
function openingHoursString(s: string): HoursInterval[] {
  const out: HoursInterval[] = [];
  const m = /^\s*([A-Za-z]{2}(?:\s*[-,]\s*[A-Za-z]{2})*)\s*(?:(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2}))?\s*$/.exec(s);
  if (!m) return out;
  const days = new Set<number>();
  for (const part of m[1]!.split(",")) {
    const [a, b] = part.split("-").map((x) => SCHEMA_DAYS[x.trim().toLowerCase()]);
    if (a === undefined) return [];
    if (b === undefined) { days.add(a); continue; }
    for (let d = a; ; d = (d + 1) % 7) { days.add(d); if (d === b || days.size >= 7) break; }
  }
  const [o, c] = m[2] ? [clock(m[2]), clock(m[3])] : [0, 0];
  if (o === null || c === null) return [];
  for (const d of days) out.push(span(d, o, c));
  return out;
}

function intervalsFromNode(node: Record<string, unknown>): HoursInterval[] {
  const out: HoursInterval[] = [];
  const specs = node.openingHoursSpecification;
  for (const spec of (Array.isArray(specs) ? specs : specs ? [specs] : []) as Record<string, unknown>[]) {
    if (!spec || typeof spec !== "object" || spec.validFrom || spec.validThrough) continue; // a holiday override, not the week
    const opens = clock(spec.opens), closes = clock(spec.closes);
    if (opens === null || closes === null) continue;
    const days = (Array.isArray(spec.dayOfWeek) ? spec.dayOfWeek : [spec.dayOfWeek]).map(dayName).filter((d): d is number => d !== null);
    for (const d of new Set(days)) out.push(span(d, opens, closes));
  }
  const strings = node.openingHours;
  for (const s of (Array.isArray(strings) ? strings : strings ? [strings] : []) as unknown[]) if (typeof s === "string") out.push(...openingHoursString(s.slice(0, 100)));
  return out;
}

/** Every object in a JSON-LD document (arrays, @graph, nested values), depth-limited. */
function* nodes(v: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (depth > 6 || !v || typeof v !== "object") return;
  if (Array.isArray(v)) { for (const x of v.slice(0, 50)) yield* nodes(x, depth + 1); return; }
  const o = v as Record<string, unknown>;
  yield o;
  for (const [k, x] of Object.entries(o)) if (k !== "openingHoursSpecification" && x && typeof x === "object") yield* nodes(x, depth + 1);
}

/**
 * Opening hours a page publishes as schema.org data: JSON-LD (`openingHoursSpecification`, or
 * `openingHours` strings) and microdata (`itemprop="openingHours"`). Data only: nothing else in the
 * page is read. The first node with hours wins; null when none.
 */
export function websiteHours(html: string): WeeklyHours | null {
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]{0,100000}?)<\/script>/gi)) {
    let doc: unknown;
    try { doc = JSON.parse(m[1]!.trim()); } catch { continue; }
    for (const n of nodes(doc)) {
      const intervals = intervalsFromNode(n);
      if (intervals.length) return { timezone: null, intervals, display: displayOf(intervals), source: "business website" };
    }
  }
  const micro = [...html.matchAll(/itemprop=["']openingHours["'][^>]*(?:content|datetime)=["']([^"']{1,100})["']/gi)].flatMap((m) => openingHoursString(m[1]!));
  return micro.length ? { timezone: null, intervals: micro, display: displayOf(micro), source: "business website" } : null;
}

// ───────────────────────────── open / next open ─────────────────────────────

/** The week's open spans in week-minutes (Sunday 00:00 = 0), merged across midnight and the week's end. */
function weekSpans(h: WeeklyHours): [number, number][] {
  const raw = h.intervals.map((i) => [i.day * DAY + i.startMinute, i.day * DAY + i.endMinute] as [number, number]).sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of raw) {
    const last = merged.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  // Saturday night into Sunday morning: the last span wraps onto the first.
  if (merged.length > 1 && merged.at(-1)![1] >= WEEK + merged[0]![0]) {
    const last = merged.pop()!;
    merged[0] = [last[0] - WEEK, Math.max(merged[0]![1], last[1] - WEEK)];
  }
  return merged;
}

const alwaysOpen = (spans: [number, number][]) => spans.some(([s, e]) => e - s >= WEEK);

function weekMinute(t: Date, tz: string): number {
  const p = localParts(t, tz);
  return p.weekday * DAY + p.minute;
}

/** Contact spans: each open span shrunk by `margin` at both ends (an always-open business has no ends). */
function contactSpans(h: WeeklyHours, margin: number): [number, number][] {
  const spans = weekSpans(h);
  if (alwaysOpen(spans)) return [[0, WEEK]];
  return spans.map(([s, e]) => [s + margin, e - margin] as [number, number]).filter(([s, e]) => e > s);
}

function inSpans(w: number, spans: [number, number][]): boolean {
  if (spans.length === 1 && spans[0]![0] === 0 && spans[0]![1] === WEEK) return true;
  return spans.some(([s, e]) => [w, w + WEEK, w - WEEK].some((x) => x >= s && x < e));
}

const zoneOf = (h: WeeklyHours, fallback: string) => h.timezone ?? fallback;

/** Is the business open at `t` (margin 0) / may it be contacted (margin 30)? */
export function openAt(h: WeeklyHours, t: Date, fallbackTimezone: string, margin = 0): boolean {
  return inSpans(weekMinute(t, zoneOf(h, fallbackTimezone)), contactSpans(h, margin));
}

/** `t` when contact is allowed then, else the next instant it is (DST-safe); null when never. */
export function nextOpenAt(h: WeeklyHours, t: Date, fallbackTimezone: string, margin = CONTACT_MARGIN_MIN): Date | null {
  const tz = zoneOf(h, fallbackTimezone);
  const spans = contactSpans(h, margin);
  if (!spans.length) return null;
  const w = weekMinute(t, tz);
  if (inSpans(w, spans)) return t;
  // The nearest span start ahead, on the local calendar (never by adding minutes across a DST change).
  const ahead = spans.map(([s]) => ((((s - w) % WEEK) + WEEK) % WEEK) || WEEK).sort((a, b) => a - b)[0]!;
  const p = localParts(t, tz);
  const target = p.minute + ahead;
  const day = new Date(Date.UTC(p.y, p.m - 1, p.d + Math.floor(target / DAY)));
  const at = zonedInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), target % DAY, tz);
  return at.getTime() > t.getTime() ? at : new Date(t.getTime() + ahead * MIN);
}

/** Calls and texts: may Haggle reach the business at `t` (open, not in its first or last 30 minutes)? */
export const contactableAt = (h: WeeklyHours, t: Date, fallbackTimezone: string) => openAt(h, t, fallbackTimezone, CONTACT_MARGIN_MIN);

const short = (m: number) => {
  const h = Math.floor((m % DAY) / 60), mm = m % 60;
  return `${h % 12 || 12}${mm ? `:${String(mm).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
};

/** "Open today 9am–5pm" / "Closed today" / "Open 24 hours today", in the business's timezone. */
export function hoursToday(h: WeeklyHours, now: Date, fallbackTimezone: string): string {
  const p = localParts(now, zoneOf(h, fallbackTimezone));
  const today = h.intervals.filter((i) => i.day === p.weekday).sort((a, b) => a.startMinute - b.startMinute);
  if (!today.length) return "Closed today";
  if (today.some((i) => i.startMinute === 0 && i.endMinute >= DAY)) return "Open 24 hours today";
  return `Open today ${today.map((i) => `${short(i.startMinute)}–${short(i.endMinute)}`).join(", ")}`;
}

// ───────────────────────────── combined slots ─────────────────────────────

/** One rule a contact time must satisfy: may it happen at `t`, and if not, the next time it may (null = never). */
export interface ContactRule {
  allows(t: Date): boolean;
  next(t: Date): Date | null;
}

/**
 * The earliest instant at or after `now` every rule allows: `now` itself when they all do, null when
 * they never meet within a few weeks (e.g. a business open only at night and operator call hours by day).
 */
export function earliestSlot(now: Date, rules: ContactRule[], maxSteps = 60): Date | null {
  let t = now;
  for (let i = 0; i < maxSteps; i++) {
    let moved = false;
    for (const r of rules) {
      if (r.allows(t)) continue;
      const n = r.next(t);
      if (!n || n.getTime() - now.getTime() > 21 * DAY * MIN) return null;
      t = n;
      moved = true;
    }
    if (!moved) return t;
  }
  return null;
}

/** A business's hours as a rule (with the 30-minute margins). */
export function businessHoursRule(h: WeeklyHours, fallbackTimezone: string): ContactRule {
  return { allows: (t) => contactableAt(h, t, fallbackTimezone), next: (t) => nextOpenAt(h, t, fallbackTimezone) };
}
