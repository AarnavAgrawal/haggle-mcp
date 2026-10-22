// PURE: normalize what an agent wrote into requirements the engine can check. An agent request in
// plain words ("at least 12 vegetarian meals", "must deliver to the venue by 11:30", "nut-free") is
// accepted as a string or with a coarse kind; this infers the kind, the dietary need and a minimum
// count from the text, so quantity checks are arithmetic instead of guesses. It never invents a
// requirement the agent didn't state, and an explicit kind/min_count from the agent always wins.
import type { Requirement } from "../contract.ts";

const DIETS = ["vegetarian", "vegan", "gluten-free", "gluten free", "halal", "kosher", "nut-free", "nut free", "dairy-free", "dairy free", "pescatarian"];

type Kind = Requirement["kind"];

function inferKind(t: string): Kind {
  const s = t.toLowerCase();
  if (DIETS.some((d) => s.includes(d)) || /\b(allerg\w*|dietary)\b/.test(s)) return "dietary";
  if (/\b(deliver\w*|drop[- ]?off|set[- ]?up at|on[- ]?site)\b/.test(s)) return "delivery";
  if (/\b(by|before|no later than|on)\s+(\d{1,2}(:\d{2})?\s*(am|pm)?|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b|\b(date|deadline|time)\b/.test(s)) return "date";
  if (/\b(at|to)\s+(the\s+)?(venue|office|address|location)\b|\b(location|address|venue)\b/.test(s)) return "location";
  if (/\b(\d+)\s*(people|guests|servings|meals|heads|attendees)\b|\bheadcount\b/.test(s)) return "quantity";
  if (/\b(licen[cs]ed|insured|insurance|certified|permit|staff|server|warranty)\b/.test(s)) return "service";
  return "other";
}

/** "at least 12 vegetarian", "12+ vegan meals", "minimum of 20": the stated minimum count. */
export function minCountFromText(t: string): number | undefined {
  const m = /\b(?:at least|min(?:imum)?(?: of)?|no fewer than)\s+(\d{1,5})\b/i.exec(t) ?? /\b(\d{1,5})\s*\+?\s*(?:or more\s+)?(?:vegetarian|vegan|gluten[- ]free|halal|kosher|nut[- ]free|dairy[- ]free|pescatarian|people|guests|servings|meals|portions|plates)\b/i.exec(t);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export type RequirementInput = string | (Partial<Requirement> & { text: string });

/** One requirement: kind inferred when absent (an explicit kind always stands), min_count from the text when absent. */
export function normalizeRequirement(r: RequirementInput, index: number): Requirement {
  const o = typeof r === "string" ? { text: r } : r;
  const text = o.text.trim().replace(/\s+/g, " ").slice(0, 200);
  const kind: Kind = o.kind ?? inferKind(text);
  const min = o.min_count ?? ((kind === "dietary" || kind === "quantity") ? minCountFromText(text) : undefined);
  return { id: o.id ?? `r${index + 1}`, kind, text, hard: o.hard ?? true, ...(min !== undefined ? { min_count: min } : {}) };
}

/** Every requirement normalized; exact duplicates (same kind and text) collapse to one; ids stay unique. */
export function normalizeRequirements(rs: readonly RequirementInput[]): Requirement[] {
  const out: Requirement[] = [];
  const seen = new Set<string>();
  const ids = new Set<string>();
  for (const [i, r] of rs.entries()) {
    const n = normalizeRequirement(r, i);
    const key = `${n.kind}:${n.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let id = n.id;
    for (let k = 2; ids.has(id); k++) id = `${n.id}_${k}`;
    ids.add(id);
    out.push({ ...n, id });
  }
  return out;
}

// ───────────────────────────── plain-language request facts (sprint 4 B) ─────────────────────────────
// What an agent passes when it relays the user's words instead of structured fields: "60 people",
// "Saturday Nov 14 at 11:30am", "under $2,500", "deliver to 500 Howard St by 11:30", "12 vegetarian".
// Each reader is deterministic and conservative: it returns undefined (and the caller asks) rather
// than guess; a structured field the agent also passed always wins. Relative days ("next Saturday",
// "tomorrow") resolve from `today` (YYYY-MM-DD, the workspace's local date when known).

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const atUtc = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

/** "60", "60 people", "about 60 guests", "headcount: 60" -> 60 (1..10,000), else undefined. */
export function headcountFrom(v: number | string | undefined): number | undefined {
  if (typeof v === "number") return Number.isInteger(v) && v >= 1 && v <= 10_000 ? v : undefined;
  if (!v) return undefined;
  const m = /(\d{1,3}(?:,\d{3})+|\d{1,5})/.exec(v);
  const n = m ? Number(m[1]!.replace(/,/g, "")) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : undefined;
}

/** "$2,500", "2.5k", "under 5k", "up to $3000", "no more than $3,000" -> USD, and whether it was said as a hard limit. */
export function budgetFrom(v: number | string | undefined): { usd: number; limit: boolean } | undefined {
  if (typeof v === "number") return v > 0 && v <= 1_000_000 ? { usd: v, limit: false } : undefined;
  if (!v) return undefined;
  const m = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|thousand)?\b/i.exec(v);
  if (!m) return undefined;
  const usd = Number(m[1]!.replace(/,/g, "")) * (m[2] ? 1000 : 1);
  if (!(usd > 0 && usd <= 1_000_000)) return undefined;
  return { usd: Math.round(usd * 100) / 100, limit: /\b(no more than|at most|max(imum)?|hard (cap|limit)|absolute(ly)?|can'?t (go over|exceed)|not (to )?exceed|ceiling)\b/i.test(v) };
}

/** "11:30", "11:30am", "11:30 a.m.", "noon", "6 pm" -> "HH:MM" (24h), else undefined (a bare number is never a time). */
export function timeFrom(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.toLowerCase().replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ").replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, " ").replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?\b(,?\s+\d{4})?/g, " ");
  if (/\bnoon\b|\bmidday\b/.test(s)) return "12:00";
  const m = /\b([01]?\d|2[0-3])(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?(?![\d/-])/.exec(s);
  if (!m || (!m[2] && !m[3])) return undefined;
  let h = Number(m[1]);
  const pm = m[3]?.startsWith("p");
  if (m[3]) {
    if (h > 12 || h === 0) return undefined;
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  return `${String(h).padStart(2, "0")}:${m[2] ?? "00"}`;
}

/** "2026-11-14", "Nov 14", "November 14, 2026", "11/14", "Saturday", "next Saturday", "tomorrow" -> YYYY-MM-DD, else undefined. */
export function dateFrom(v: string | undefined, today: string): string | undefined {
  if (!v) return undefined;
  const s = v.toLowerCase().trim();
  const isoHit = /\b(\d{4}-\d{2}-\d{2})\b/.exec(s)?.[1];
  if (isoHit) return Number.isNaN(atUtc(isoHit).getTime()) ? undefined : isoHit;
  const t = atUtc(today);
  if (/\btoday\b/.test(s)) return today;
  if (/\btomorrow\b/.test(s)) return isoDay(new Date(t.getTime() + 86_400_000));
  const md = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/.exec(s);
  const num = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(s);
  const hit = md ? { m: MONTH_NAMES.indexOf(md[1]!), d: Number(md[2]), y: md[3] ? Number(md[3]) : undefined }
    : num ? { m: Number(num[1]) - 1, d: Number(num[2]), y: num[3] ? Number(num[3].length === 2 ? `20${num[3]}` : num[3]) : undefined } : null;
  if (hit) {
    if (hit.m < 0 || hit.m > 11 || hit.d < 1 || hit.d > 31) return undefined;
    const make = (y: number) => { const d = new Date(Date.UTC(y, hit.m, hit.d)); return d.getUTCMonth() === hit.m ? isoDay(d) : undefined; };
    if (hit.y !== undefined) return make(hit.y);
    const thisYear = make(t.getUTCFullYear());
    return thisYear && thisYear >= today ? thisYear : make(t.getUTCFullYear() + 1);
  }
  const wd = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/.exec(s);
  if (wd) {
    // The coming one, never today: "Saturday" said on a Saturday means next week's, as people mean it.
    const ahead = ((DAY_NAMES.indexOf(wd[1]!) - t.getUTCDay() + 7) % 7) || 7;
    return isoDay(new Date(t.getTime() + ahead * 86_400_000));
  }
  return undefined;
}

/** "12 vegetarian" -> "At least 12 vegetarian meals"; anything else stays in the user's words. */
export function dietaryRequirement(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  const m = /^(?:at least\s+)?(\d{1,5})\s*\+?\s*(vegetarian|vegan|gluten[- ]free|halal|kosher|nut[- ]free|dairy[- ]free|pescatarian)(?:\s+(?:meals|plates|portions|servings|options))?$/i.exec(t);
  return m ? `At least ${m[1]} ${m[2]!.toLowerCase()} meals` : t;
}

/** "deliver to 500 Howard St by 11:30" -> the place (a venue), the time, and a delivery requirement in the user's words. */
export function deliveryFrom(text: string | undefined): { venue?: string; requirement?: string; time?: string } {
  const t = text?.trim().replace(/\s+/g, " ");
  if (!t) return {};
  const place = /\b(?:to|at)\s+(.+?)(?=\s+(?:by|before|no later than)\s|\s*[,;]\s*|$)/i.exec(t)?.[1]?.trim();
  const time = timeFrom(/\b(?:by|before|no later than)\s+([^,;]+)$/i.exec(t)?.[1]);
  const requirement = /^deliver/i.test(t) ? `${t[0]!.toUpperCase()}${t.slice(1)}` : `Delivered ${/^(to|at|by)\b/i.test(t) ? "" : "to "}${t}`;
  return { ...(place && !/^\d{1,2}(:\d{2})?\s*(am|pm)?$/i.test(place) ? { venue: place } : {}), requirement, ...(time ? { time } : {}) };
}

export interface PlainRequest {
  quantity?: number | string;
  headcount?: number | string;
  date?: string;
  when?: string;
  time?: string;
  where?: string;
  area?: string;
  venue?: string;
  delivery?: string;
  dietary?: string | string[];
}

export interface NormalizedFacts {
  quantity?: number;
  date?: string;
  time?: string;
  area?: string;
  venue?: string;
  /** Requirements in the user's words (dietary, delivery), merged with the explicit ones by the caller. */
  requirements: string[];
  /** What couldn't be read, by field, for the agent to ask about (never guessed). */
  unreadable: string[];
}

/**
 * The request facts from plain words. Structured values (a number quantity, a YYYY-MM-DD date, an
 * HH:MM time) pass through unchanged; words are read by the helpers above; nothing is invented.
 */
export function normalizePlainRequest(r: PlainRequest, today: string): NormalizedFacts {
  const unreadable: string[] = [];
  const count = r.quantity ?? r.headcount;
  const quantity = headcountFrom(count);
  if (count !== undefined && quantity === undefined) unreadable.push(`headcount "${String(count).slice(0, 40)}"`);
  const whenText = r.date ?? r.when;
  const date = dateFrom(whenText, today);
  if (whenText !== undefined && date === undefined) unreadable.push(`date "${whenText.slice(0, 40)}"`);
  const delivery = deliveryFrom(r.delivery);
  const time = (r.time && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.time) ? r.time : timeFrom(r.time)) ?? timeFrom(r.when) ?? (r.date && !/^\d{4}-\d{2}-\d{2}$/.test(r.date) ? timeFrom(r.date) : undefined);
  if (r.time !== undefined && time === undefined) unreadable.push(`time "${r.time.slice(0, 20)}"`);
  const venue = r.venue ?? delivery.venue;
  const area = r.area ?? r.where;
  const diets = (Array.isArray(r.dietary) ? r.dietary : r.dietary ? r.dietary.split(/\s*;\s*|\s*,\s*/) : []).map((d) => d.trim()).filter((d) => d.length >= 3).map(dietaryRequirement);
  return {
    ...(quantity !== undefined ? { quantity } : {}), ...(date ? { date } : {}), ...(time ? { time } : {}), ...(area ? { area } : {}), ...(venue ? { venue } : {}),
    requirements: [...diets, ...(delivery.requirement ? [delivery.requirement] : [])], unreadable,
  };
}

/** The must-haves of a request as one line for later messages ("At least 12 vegetarian meals; Delivered by 11:30"), or null. */
export function mustHaveLine(reqs: readonly { text: string; hard: boolean }[] | undefined): string | null {
  const hard = (reqs ?? []).filter((r) => r.hard).map((r) => r.text);
  return hard.length ? hard.join("; ") : null;
}
