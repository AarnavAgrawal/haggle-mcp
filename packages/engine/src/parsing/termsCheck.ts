// PURE: does a quote's terms match the request? A price read perfectly is still the wrong offer when
// the business quotes another day ("we're booked on the 29th, but we can do the 30th"), can only
// deliver in a window that misses the requested time ("drivers only deliver 9-10:30 AM" for a 12:00
// lunch), or the reply is written as a different business than the one Haggle contacted ("this is
// Golden Gate Grill, we share this inbox"). Each sets a flag that blocks approval until the human
// sees it: date_mismatch, delivery_window_mismatch, identity_mismatch.
//
// Two sources, either is enough: what the reader extracted (offered_date, offered_time,
// delivery_window, signed_as) and a conservative deterministic scan of the business's own words
// (email/text: quoted history already removed). The scan only fires on an offer phrase next to a
// different date, an explicit delivery window, or a signature/"this is" naming a business whose
// distinctive words share nothing with the contacted business's name.

export type TermsFlag = "date_mismatch" | "delivery_window_mismatch" | "identity_mismatch";

export interface TermsRequest {
  /** YYYY-MM-DD */
  date?: string;
  /** Last day of a flexible range, YYYY-MM-DD. */
  date_until?: string;
  /** HH:MM (24h) the order is for. */
  time?: string;
}

export interface TermsExtraction {
  offered_date?: string | null;
  offered_time?: string | null;
  delivery_window?: { start: string; end: string } | null;
  signed_as?: string | null;
}

export interface TermsResult {
  flags: TermsFlag[];
  notes: string[];
  offered_date?: string;
  delivery_window?: string;
  signed_as?: string;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const OFFER = /\b(?:can|could|would|will)\s+(?:do|make|cater|deliver|serve|offer|fit you in|take it)\b|\b(?:available|free|open)\s+(?:on|for)\b|\binstead\b|\bworks for us\b|\bhow about\b|\bwhat about\b/i;
/** Generic words that don't identify a business. */
const GENERIC = new Set(["the", "and", "of", "a", "co", "company", "llc", "inc", "ltd", "catering", "caterer", "caterers", "kitchen", "grill", "bakery", "deli", "cafe", "café", "restaurant", "bistro", "eats", "foods", "food", "events", "event", "table", "taqueria", "pizzeria", "bbq", "bar", "market", "group", "services", "sf", "san", "francisco"]);
const BUSINESS_WORD = /\b(?:catering|caterers?|kitchen|grill|bakery|deli|cafe|café|restaurant|bistro|eats|foods?|events|table|taqueria|pizzeria|bbq|bar|market|co\.?|company|llc|inc\.?)\b/i;

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

function inRange(d: string, req: TermsRequest): boolean {
  if (!req.date) return true;
  return d >= req.date && d <= (req.date_until && req.date_until > req.date ? req.date_until : req.date);
}

/** Calendar dates a sentence names, resolved around the requested date (same month/year; weekdays within ±6 days). */
function datesIn(sentence: string, req: TermsRequest): string[] {
  if (!req.date) return [];
  const [y, m, d] = req.date.split("-").map(Number) as [number, number, number];
  const base = Date.UTC(y, m - 1, d);
  const out = new Set<string>();
  for (const x of sentence.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.add(`${x[1]}-${x[2]}-${x[3]}`);
  for (const x of sentence.matchAll(new RegExp(`\\b(${MONTHS.map((s) => s.slice(0, 3)).join("|")})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "gi"))) {
    out.add(iso(y, MONTHS.findIndex((mo) => mo.startsWith(x[1]!.toLowerCase())) + 1, Number(x[2])));
  }
  for (const x of sentence.matchAll(/\b(?:the\s+)?(\d{1,2})(st|nd|rd|th)\b/gi)) {
    const day = Number(x[1]);
    if (day >= 1 && day <= 31) out.add(iso(y, m, day));
  }
  for (const x of sentence.matchAll(new RegExp(`\\b(${DAYS.join("|")})\\b`, "gi"))) {
    const want = DAYS.indexOf(x[1]!.toLowerCase());
    // The nearest such weekday to the requested date (later first on a tie).
    for (const off of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6]) {
      const t = new Date(base + off * 86_400_000);
      // A weekday right next to an explicit day ("Friday the 30th") is the same date: keep the explicit one.
      if (t.getUTCDay() === want && !/\b\d{1,2}(?:st|nd|rd|th)\b/i.test(sentence)) { out.add(iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())); break; }
    }
  }
  return [...out];
}

/** "9:00", "9", "10:30 AM", "noon" -> minutes after midnight; `ampm` applies when the time has none. */
function minutes(s: string, ampm?: string): number | null {
  const t = s.trim().toLowerCase();
  if (t === "noon") return 12 * 60;
  const x = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (!x) return null;
  let h = Number(x[1]);
  const mer = (x[3] ?? ampm ?? "").replace(/\./g, "");
  if (mer === "pm" && h < 12) h += 12;
  if (mer === "am" && h === 12) h = 0;
  return h > 23 ? null : h * 60 + Number(x[2] ?? 0);
}
const hhmm = (n: number) => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;

/** The delivery window the business states, from its words: "only deliver between 9:00 and 10:30 AM", "delivery 9-10:30am". */
function windowIn(text: string): { start: number; end: number } | null {
  const T = String.raw`(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?|noon)`;
  const x = text.match(new RegExp(String.raw`\b(?:deliver(?:y|ies|s)?|drop[- ]?off|arriv(?:e|al))\b[^.!?\n]{0,60}?\b(?:between|from)?\s*${T}\s*(?:and|to|-|–|until)\s*${T}`, "i"));
  if (!x) return null;
  const endMer = x[2]!.match(/(am|pm|a\.m\.|p\.m\.)/i)?.[1]?.toLowerCase();
  const start = minutes(x[1]!, endMer);
  const end = minutes(x[2]!);
  return start !== null && end !== null && end > start ? { start, end } : null;
}

/** Distinctive words of a business name ("Harborview Catering" -> harborview). */
function distinctive(name: string): Set<string> {
  return new Set(name.toLowerCase().replace(/[^a-z0-9& ]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !GENERIC.has(w)));
}

/** The business the reply is written or signed as, from its own words (null if it names none). */
function signedAsIn(own: string): string | null {
  const NAME = String.raw`([A-Z][\w&'’.-]*(?:\s+(?:&|and|of|the|[A-Z][\w&'’.-]*)){0,5})`;
  const intro = own.match(new RegExp(String.raw`\b(?:this is|it's|it is|we are|we're)\s+${NAME}`));
  if (intro && BUSINESS_WORD.test(intro[1]!)) return intro[1]!.trim();
  const lines = own.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const l of lines.slice(-3).reverse()) {
    const sig = l.replace(/^[-–—]+\s*/, "").replace(/^(?:thanks|thank you|best|regards|cheers)[,!]?\s*/i, "");
    const parts = sig.split(/\s*[,|·•–-]\s*/).filter(Boolean);
    for (const p of parts) if (/^[A-Z]/.test(p) && p.split(/\s+/).length <= 5 && BUSINESS_WORD.test(p) && !/[.?!:$]/.test(p.replace(/\b(?:co|inc)\.$/i, ""))) return p;
  }
  return null;
}

/**
 * `x`: the reader's extraction. offered_date / offered_time / delivery_window / signed_as are used when
 * it has them; the live Claude schemas don't carry them yet (a new field needs a live grammar-size
 * check, tests/productionGuards.test.ts), so today the business's own words decide.
 */
export function termsMismatch(i: { own: string | null; x: object; request: TermsRequest; businessName: string }): TermsResult {
  const x = i.x as TermsExtraction;
  const flags = new Set<TermsFlag>();
  const notes: string[] = [];
  const out: TermsResult = { flags: [], notes };
  const own = i.own ?? "";

  // Date: the reader's offered date, or an offer phrase in the business's words next to another date.
  if (i.request.date) {
    const offered = x.offered_date && /^\d{4}-\d{2}-\d{2}$/.test(x.offered_date) ? x.offered_date : null;
    let other: string | null = offered && !inRange(offered, i.request) ? offered : null;
    if (!other) {
      for (const s of own.split(/(?<=[.!?;:])\s+|\n+|,\s*but\s+|\bbut\b/i)) {
        if (!OFFER.test(s)) continue;
        const ds = datesIn(s, i.request);
        if (ds.length && ds.every((d) => !inRange(d, i.request))) { other = ds[0]!; break; }
      }
    }
    if (other) {
      flags.add("date_mismatch");
      out.offered_date = other;
      notes.push(`The business offers ${other}, not the requested ${i.request.date}${i.request.date_until ? `–${i.request.date_until}` : ""}`);
    }
  }

  // Time: a delivery window that ends more than an hour before (or starts after) the requested time.
  const want = i.request.time ? minutes(i.request.time) : null;
  if (want !== null) {
    const w = x.delivery_window ? { start: minutes(x.delivery_window.start), end: minutes(x.delivery_window.end) } : null;
    const win = w && w.start !== null && w.end !== null && w.end > w.start ? (w as { start: number; end: number }) : windowIn(own);
    if (win && (win.start > want || win.end < want - 60)) {
      flags.add("delivery_window_mismatch");
      out.delivery_window = `${hhmm(win.start)}-${hhmm(win.end)}`;
      notes.push(`Delivery only ${hhmm(win.start)}-${hhmm(win.end)}, for a ${hhmm(want)} order`);
    }
    const t = x.offered_time ? minutes(x.offered_time) : null;
    if (t !== null && Math.abs(t - want) > 90 && !flags.has("delivery_window_mismatch")) {
      flags.add("delivery_window_mismatch");
      notes.push(`The business offers ${hhmm(t)}, not the requested ${hhmm(want)}`);
    }
  }

  // Identity: written or signed as a business whose distinctive name shares nothing with the contacted one.
  const ours = distinctive(i.businessName);
  // A person's name ("Maria") is not a business: only a name with a business word counts.
  const extracted = x.signed_as?.trim() && BUSINESS_WORD.test(x.signed_as) ? x.signed_as.trim() : null;
  const signed = extracted ?? signedAsIn(own);
  if (signed && ours.size) {
    const theirs = distinctive(signed);
    if (theirs.size && ![...theirs].some((w) => ours.has(w))) {
      flags.add("identity_mismatch");
      out.signed_as = signed.slice(0, 80);
      notes.push(`Written as "${signed.slice(0, 60)}", not ${i.businessName}`);
    }
  }
  out.flags = [...flags];
  return out;
}
