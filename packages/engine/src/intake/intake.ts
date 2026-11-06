// PURE: how a good human assistant buys, as data. For each kind of purchase:
// - essentials: what a business needs to quote at all (the user is asked before anything is sent);
// - helpful: optional details that change the price (asked in the same message, never required);
// - vendorAsks: what we need back from every business so the human can decide (the RFQ, the first
//   call and the iMessage ask for them; a reply that leaves out a decision-critical one is chased once).
// Uses only the existing Request fields (what, quantity, date, time, area, venue, details[], ask[],
// requirements): an answer the Request has no field for goes in details[] under the suggested label.

import { cuisineOf, priceRangeOf } from "../reputation/vendorSearch.ts";

/** A request as intake reads it: the engine's Request, or deal's input before it is normalized. */
export interface IntakeInput {
  what: string;
  quantity?: number | string | null;
  unit?: string | null;
  date?: string | null;
  date_until?: string | null;
  time?: string | null;
  area?: string | null;
  venue?: string | null;
  details?: { label: string; value: string }[] | null;
  ask?: { key: string; label: string }[] | null;
  requirements?: { text: string; kind?: string }[] | null;
}

export type IntakeCategory = "catering" | "event_services" | "home_repair" | "cleaning" | "moving" | "printing" | "general";

/** One question for the user, and where its answer goes in deal's request. */
export interface IntakeQuestion {
  key: string;
  /** Plain words, ready to put in front of the user. */
  question: string;
  /** Where the answer goes: a Request field ("quantity", "date", "area or venue") or "details: <Label>". */
  field: string;
}

/** Where a vendor ask's answer lands in a parsed reply (parsing/extraction.ts), when it has a home. */
export type VendorAskCovers = "total" | "per_unit" | "deposit" | "cancellation" | "exclusions" | "valid_until" | "available";

/** One thing we ask every business to tell us, so the human can decide. */
export interface VendorAsk {
  key: string;
  /** Email wording (a list line). */
  text: string;
  /** Spoken wording for the Voice AI brief (short). */
  voice: string;
  /** A few words for a 159-char text. */
  short: string;
  /** The parsed-reply field that holds the answer, when there is one (used to chase it once). */
  covers?: VendorAskCovers;
  /** Decision-critical: when a reply leaves it out, Haggle asks once for it. */
  critical?: boolean;
}

interface Essential extends IntakeQuestion {
  has(r: IntakeInput): boolean;
}

export interface CategoryProfile {
  id: IntakeCategory;
  label: string;
  essentials: Essential[];
  helpful: Essential[];
  /** Category asks, in priority order (they follow the all-in total). */
  vendorAsks: VendorAsk[];
  /** Common asks that are decision-critical for this kind of purchase (e.g. the cancellation policy for an event). */
  critical: VendorAskCovers[];
  /** What "all-in" covers in the first email: "including delivery, tax and fees". */
  allIn: string;
  /** At most one category ask the all-in price can't carry, for the first email (e.g. a repair's earliest arrival). */
  firstAsk?: { key: string; text: string };
}

// ───────────────────────────── reading a request ─────────────────────────────

const filled = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== "";
/** A detail whose label (or value) matches. */
const detail = (r: IntakeInput, label: RegExp, value?: RegExp) => (r.details ?? []).some((d) => label.test(d.label) || (value ? value.test(d.value) : false));
/** The request's own words: what, details and requirements. */
const words = (r: IntakeInput) => [r.what, ...(r.details ?? []).map((d) => `${d.label} ${d.value}`), ...(r.requirements ?? []).map((q) => q.text)].join(" \n ");
const whereGiven = (r: IntakeInput) => filled(r.area) || filled(r.venue) || detail(r, /\b(address|location|where|venue|site|neighbou?rhood|zip)\b/i);
// Asking every business for its earliest date (ask[]) means "as soon as you can": timing is given.
const whenGiven = (r: IntakeInput) => filled(r.date) || filled(r.time) || (r.ask ?? []).some((f) => /\b(earliest|availab\w*|soonest|start)\b/i.test(`${f.key.replace(/_/g, " ")} ${f.label}`)) || detail(r, /\b(when|date|timing|urgen\w*|deadline|availab\w*|by)\b/i) || /\b(asap|urgent\w*|emergency|today|tomorrow|this week|next week|any ?time|flexible)\b/i.test(words(r));
/** Meaningful words in `what` ("fix a leaking pipe" -> 3: fix, leaking, pipe). */
const whatWords = (r: IntakeInput) => r.what.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !/^(a|an|the|of|for|to|my|our|some|and|in|on|at|need|needs|want|get|quote|quotes)$/.test(w)).length;

// ───────────────────────────── shared questions ─────────────────────────────

const WHERE = (question: string): Essential => ({ key: "where", question, field: "area or venue", has: whereGiven });
const DATE = (question: string): Essential => ({ key: "date", question, field: "date", has: (r) => filled(r.date) });
const TIME = (question: string): Essential => ({ key: "time", question, field: "time", has: (r) => filled(r.time) || detail(r, /\b(time|hours?|window|arrival)\b/i) });

// ───────────────────────────── vendor asks ─────────────────────────────

/** Asked of every business, whatever it sells (the per-unit price only for a counted order). */
function commonAsks(r: IntakeInput): { first: VendorAsk; rest: VendorAsk[] } {
  const qty = typeof r.quantity === "number" ? r.quantity : Number.NaN;
  const unit = (r.unit ?? "people").trim().toLowerCase();
  const per = unit === "people" || unit === "persons" || unit === "guests" ? "person" : unit.replace(/s$/, "") || "unit";
  const when = filled(r.date) || filled(r.time);
  return {
    first: { key: "total", text: "An itemized all-in total: the subtotal plus any delivery, travel, setup or service fees, tax and gratuity", voice: "the all-in total, itemized: subtotal, any delivery, travel, setup or service fees, tax and gratuity", short: "all-in total", covers: "total" },
    rest: [
      { key: "included", text: "What's included, and anything that isn't", voice: "what is included and what is not", short: "what's included", covers: "exclusions" },
      ...(qty > 1 ? [{ key: "per_unit", text: `The price per ${per}`, voice: `the price per ${per}`, short: `price per ${per}`, covers: "per_unit" as const }] : []),
      { key: "deposit", text: "Any deposit, when it's due, and your payment terms", voice: "any deposit, when it is due, and payment terms", short: "deposit", covers: "deposit" },
      { key: "availability", text: when ? "That you're available for that date and time (or the closest you can do)" : "When you could do it", voice: when ? "that they are available for that date and time" : "when they could do it", short: when ? "availability" : "earliest date", covers: "available" },
      { key: "cancellation", text: "Your cancellation and change policy", voice: "their cancellation and change policy", short: "cancellation policy", covers: "cancellation" },
    ],
  };
}

const ask = (key: string, text: string, voice: string, short: string): VendorAsk => ({ key, text, voice, short });

// ───────────────────────────── the profiles ─────────────────────────────

export const CATEGORY_PROFILES: Record<IntakeCategory, CategoryProfile> = {
  catering: {
    id: "catering", label: "Catering",
    essentials: [
      { key: "headcount", question: "How many people?", field: "quantity", has: (r) => filled(r.quantity) },
      DATE("What date is it?"),
      WHERE("Where should it be delivered (address or venue, or at least the city)?"),
    ],
    helpful: [
      { key: "food", question: "Any cuisine you'd like (e.g. pizza, Mexican, Indian)? If you're open, Haggle shows a mix.", field: "details: Cuisine", has: (r) => !!cuisineOf(r.what) || detail(r, /\b(menu|cuisine|food|dish)\w*/i) },
      { key: "price_range", question: "What price point: as cheap as possible, mid-range, or something fancy? If you don't mind, Haggle shows a range.", field: "details: Price range", has: (r) => !!priceRangeOf(r.what) || detail(r, /\bprice\b/i) },
      TIME("What time should the food arrive or be served?"),
      { key: "dietary", question: "Any dietary needs or allergies, and how many people each (e.g. 12 vegetarian, 2 gluten-free)?", field: "requirements", has: (r) => (r.requirements ?? []).some((q) => q.kind === "dietary") || detail(r, /\b(diet|allerg|vegetarian|vegan|gluten|halal|kosher)\w*/i) || /\b(vegetarian|vegan|gluten|halal|kosher|allerg\w*|nut-free)\b/i.test(words(r)) },
      { key: "service", question: "Drop-off, buffet set-up, or staffed service? Do you need plates and utensils?", field: "details: Service", has: (r) => detail(r, /\b(service|style|setup|set-up|staff\w*|plates?|utensils?)\b/i) || /\b(drop[- ]?off|buffet|plated|family[- ]style|boxed|staffed)\b/i.test(words(r)) },
    ],
    vendorAsks: [
      ask("menu", "The menu or items you'd serve", "the menu or items they would serve", "menu"),
      ask("service_included", "Whether delivery, setup, serving staff, plates and utensils are included", "whether delivery, setup, staff, plates and utensils are included", "delivery incl.?"),
    ],
    // The cancellation policy is asked in a follow-up only when the reply leaves it out (followUpGaps).
    critical: ["deposit"],
    allIn: "including delivery, tax and fees",
  },
  event_services: {
    id: "event_services", label: "Event rentals & staffing",
    essentials: [
      { key: "scope", question: "What exactly, and how many (e.g. 100 chairs and 10 tables, or a DJ for 4 hours)?", field: "quantity or details: Items", has: (r) => filled(r.quantity) || detail(r, /\b(items?|quantit\w*|count|hours?|duration|length|package|list|staff)\b/i) || /\d/.test(r.what) },
      DATE("What date is the event?"),
      WHERE("Where is the event (venue or address)?"),
    ],
    helpful: [
      TIME("What are the start and end times (including setup and teardown)?"),
      { key: "guests", question: "How many guests?", field: "details: Guests", has: (r) => detail(r, /\bguests?|attendees|headcount\b/i) || /\b\d+\s*(guests?|people|attendees)\b/i.test(words(r)) },
      { key: "setting", question: "Indoors or outdoors? Any venue access limits (stairs, loading dock, parking)?", field: "details: Venue notes", has: (r) => detail(r, /\b(indoor|outdoor|access|setting|venue notes?)\b/i) || /\b(indoors?|outdoors?)\b/i.test(words(r)) },
    ],
    vendorAsks: [
      ask("logistics_fees", "Delivery, setup and pickup fees, and the times they'd arrive and pick up", "delivery, setup and pickup fees and times", "delivery/setup fees"),
      ask("damage", "Any security deposit or damage waiver", "any security deposit or damage waiver", "damage waiver"),
      ask("overtime", "The overtime rate if the event runs long", "the overtime rate if it runs long", "overtime rate"),
    ],
    critical: ["deposit", "cancellation"],
    allIn: "including delivery, setup, pickup and fees",
  },
  home_repair: {
    id: "home_repair", label: "Home repair",
    essentials: [
      { key: "problem", question: "What's wrong, and where in the home (e.g. a leaking pipe under the kitchen sink)?", field: "what or details: Problem", has: (r) => whatWords(r) >= 3 || detail(r, /\b(problem|issue|symptom|fixture|appliance|scope|description|work|job|room|location in home)\b/i) },
      WHERE("What's the address (or at least the neighborhood and city)?"),
      { key: "timing", question: "When do you need it done: is it urgent, or which days work?", field: "date or details: Timing", has: whenGiven },
    ],
    helpful: [
      { key: "property", question: "House, apartment or condo, and do you own or rent?", field: "details: Property", has: (r) => detail(r, /\b(property|home type|house|apartment|condo|own|rent)\b/i) || /\b(house|apartment|condo|townhouse)\b/i.test(words(r)) },
      { key: "equipment", question: "Make, model or age of what needs fixing, if you know it?", field: "details: Equipment", has: (r) => detail(r, /\b(make|model|brand|age|equipment)\b/i) },
      { key: "access", question: "Anything about access or parking the tech should know?", field: "details: Access", has: (r) => detail(r, /\b(access|parking|gate|entry)\b/i) },
    ],
    vendorAsks: [
      ask("callout_fee", "Any call-out, trip or diagnostic fee", "any call-out, trip or diagnostic fee", "call-out fee"),
      ask("pricing_basis", "Whether it's a flat price or hourly (the rate and estimated hours)", "whether it is a flat price or hourly, with the rate and estimated hours", "flat or hourly"),
      ask("parts", "Parts and materials, and whether they're in the total", "parts and materials, and whether they are in the total", "parts"),
      ask("arrival", "Your earliest arrival time", "their earliest arrival time", "earliest arrival"),
      ask("warranty", "Any warranty on labor and parts", "any warranty on labor and parts", "warranty"),
      ask("licensed", "Whether you're licensed and insured", "whether they are licensed and insured", "licensed?"),
    ],
    critical: ["deposit"],
    allIn: "including labor, parts, any trip fee and tax",
    firstAsk: { key: "arrival", text: "your earliest arrival time" },
  },
  cleaning: {
    id: "cleaning", label: "Cleaning",
    essentials: [
      { key: "size", question: "How big is the place (bedrooms and bathrooms, or square feet)?", field: "quantity or details: Size", has: (r) => filled(r.quantity) || detail(r, /\b(size|sq\w*|square|bed\w*|bath\w*|rooms?|footage|area)\b/i) || /\b\d+\s*(bed\w*|bath\w*|br|ba|sq\w*|square|rooms?|offices?|desks?)\b|\bstudio\b/i.test(words(r)) },
      DATE("What date (or which days) would you like it?"),
      WHERE("What's the address (or at least the neighborhood and city)?"),
    ],
    helpful: [
      { key: "kind", question: "Regular, deep or move-out clean?", field: "details: Type of clean", has: (r) => detail(r, /\b(type|kind)\b/i) || /\b(deep|move[- ]?(out|in)|regular|standard|post[- ]construction|turnover)\b/i.test(words(r)) },
      { key: "frequency", question: "One time, or recurring (weekly, every two weeks)?", field: "details: Frequency", has: (r) => detail(r, /\bfrequen\w*|recurr\w*\b/i) || /\b(one[- ]time|once|weekly|biweekly|monthly|every (other|two) weeks?)\b/i.test(words(r)) },
      { key: "extras", question: "Any extras (inside the oven or fridge, windows, laundry) or pets?", field: "details: Extras", has: (r) => detail(r, /\b(extras?|pets?|oven|fridge|windows?|laundry)\b/i) },
    ],
    vendorAsks: [
      ask("hours_crew", "How many hours and cleaners it will take", "how many hours and cleaners it will take", "hours + crew"),
      ask("pricing_basis", "Whether it's a flat price or an hourly rate", "whether it is a flat price or an hourly rate", "flat or hourly"),
      ask("supplies", "Whether supplies and equipment are included", "whether supplies and equipment are included", "supplies incl.?"),
      ask("recurring", "Any lower price for recurring cleans (weekly or every two weeks)", "any lower price for recurring cleans", "recurring price"),
    ],
    critical: ["deposit"],
    allIn: "including supplies and fees",
  },
  moving: {
    id: "moving", label: "Moving",
    essentials: [
      { key: "route", question: "Moving from where to where (addresses, or at least the neighborhoods)?", field: "details: From, details: To", has: (r) => (detail(r, /\b(from|origin|pick[- ]?up|current address)\b/i) && detail(r, /\b(to|destination|drop[- ]?off|new address)\b/i)) || /\bfrom\b.+\bto\b/i.test(words(r)) },
      { key: "size", question: "How much is moving (e.g. a 2-bedroom apartment, or a list of the big items)?", field: "quantity or details: Size", has: (r) => filled(r.quantity) || detail(r, /\b(size|bed\w*|rooms?|items?|inventory|volume|sq\w*)\b/i) || /\b\d+\s*-?\s*(bed\w*|br|rooms?)\b|\bstudio\b/i.test(words(r)) },
      DATE("What date is the move?"),
    ],
    helpful: [
      { key: "stairs", question: "Stairs or an elevator at either end, and how far is the truck from the door?", field: "details: Access", has: (r) => detail(r, /\b(stairs?|elevator|floor|access|carry)\b/i) || /\b(stairs?|elevator|walk-?up)\b/i.test(words(r)) },
      { key: "packing", question: "Do you need packing help or boxes?", field: "details: Packing", has: (r) => detail(r, /\bpack\w*|boxes\b/i) || /\bpack\w*\b/i.test(words(r)) },
      { key: "special", question: "Any heavy or fragile items (piano, safe, art)?", field: "details: Special items", has: (r) => detail(r, /\b(special|heavy|fragile|piano|safe)\b/i) },
    ],
    vendorAsks: [
      ask("crew_truck", "Crew size and truck size", "the crew size and truck size", "crew + truck"),
      ask("pricing_basis", "Your hourly rate and minimum hours, or a flat price", "their hourly rate and minimum hours, or a flat price", "hourly + minimum"),
      ask("extra_fees", "Any travel or truck fee, and charges for stairs, long carries or heavy items", "any travel or truck fee, and charges for stairs, long carries or heavy items", "stairs/travel fees"),
      ask("packing", "Packing materials, and whether packing is included", "packing materials and whether packing is included", "packing"),
      ask("insurance", "Insurance or valuation coverage", "their insurance or valuation coverage", "insurance"),
      ask("arrival", "Your arrival window", "their arrival window", "arrival window"),
    ],
    critical: ["deposit", "cancellation"],
    allIn: "including travel, truck and any fees",
    firstAsk: { key: "pricing_basis", text: "your hourly rate and minimum hours, if you charge by the hour" },
  },
  printing: {
    id: "printing", label: "Printing & merch",
    essentials: [
      { key: "spec", question: "What exactly (size, material, colors, sides; e.g. 18x24 glossy posters, full color)?", field: "what or details: Specs", has: (r) => whatWords(r) >= 2 || detail(r, /\b(size|spec\w*|dimension\w*|material|paper|colou?rs?|sides?|finish|stock)\b/i) },
      { key: "quantity", question: "How many (and the size or color breakdown if it varies)?", field: "quantity", has: (r) => filled(r.quantity) || detail(r, /\b(quantit\w*|count|how many|breakdown)\b/i) },
      { key: "needed_by", question: "When do you need them in hand?", field: "date", has: (r) => filled(r.date) || detail(r, /\b(needed by|deadline|in hand|by)\b/i) },
    ],
    helpful: [
      { key: "artwork", question: "Is the artwork print-ready, or do you need design help?", field: "details: Artwork", has: (r) => detail(r, /\b(artwork|design|file|logo|art)\b/i) },
      { key: "delivery", question: "Delivered (to what address) or picked up?", field: "venue or details: Delivery", has: (r) => filled(r.venue) || detail(r, /\b(deliver\w*|ship\w*|pick[- ]?up)\b/i) },
    ],
    vendorAsks: [
      ask("unit_setup", "The unit price at this quantity, and any setup, plate or screen fees", "the unit price at this quantity and any setup, plate or screen fees", "unit price + setup"),
      ask("proof", "Whether you send a proof before printing", "whether they send a proof before printing", "proof?"),
      ask("turnaround", "Production turnaround", "the production turnaround", "turnaround"),
      ask("shipping", "Shipping or delivery cost, and the date it would arrive", "shipping or delivery cost and the arrival date", "shipping + arrival"),
      ask("rush", "Any rush fee needed to meet the date", "any rush fee needed to meet the date", "rush fee"),
      ask("files", "What file format you need", "what file format they need", "file format"),
    ],
    critical: ["deposit"],
    allIn: "including setup, shipping and tax",
    firstAsk: { key: "shipping", text: "the date they would arrive" },
  },
  general: {
    id: "general", label: "General",
    essentials: [
      { key: "scope", question: "What exactly do you need (a sentence or two a business could quote from)?", field: "what or details: Scope", has: (r) => whatWords(r) >= 2 || (r.details ?? []).length > 0 },
      WHERE("Where (address, or at least the city)?"),
      { key: "timing", question: "When do you need it?", field: "date or details: Timing", has: whenGiven },
    ],
    helpful: [
      { key: "quantity", question: "How many, if it's a counted order?", field: "quantity", has: (r) => filled(r.quantity) },
    ],
    vendorAsks: [],
    critical: ["deposit"],
    allIn: "including any fees and tax",
  },
};

// ───────────────────────────── classify ─────────────────────────────

const MATCHERS: [IntakeCategory, RegExp][] = [
  ["catering", /\b(cater\w*|lunch\w*|dinner\w*|breakfast\w*|brunch\w*|meals?|food|buffet|snacks?|pizza|tacos?|sandwich\w*|bento|boxed lunch\w*|appetizers?|hors d|desserts?|cakes?|coffee service|bbq|barbecue)\b/i],
  ["event_services", /\b(rentals?|rent(?:ing)?|tents?|furniture|chairs?|tables?|linens?|bartend\w*|wait ?staff|event staff\w*|servers|photograph\w*|videograph\w*|headshots?|dj|band|musicians?|entertain\w*|av|audio|sound system|projectors?|stage|decor\w*|florists?|flowers)\b/i],
  ["cleaning", /\b(clean\w*|janitor\w*|maids?|housekeep\w*)\b/i],
  ["moving", /\b(movers?|moving|move|relocat\w*|junk removal|haul\w*)\b/i],
  ["printing", /\b(print\w*|flyers?|banners?|posters?|stickers?|signage|t-?shirts?|tees|merch\w*|swag|business cards?|brochures?|mugs?|hoodies?|embroider\w*)\b/i],
  ["home_repair", /\b(plumb\w*|leak\w*|pipes?|drains?|toilets?|faucets?|water heater|electric\w*|wiring|outlets?|breakers?|hvac|furnace|air condition\w*|heating|repairs?|handyman|fix\w*|maintenance|install\w*|replace\w*|roof\w*|paint\w*|drywall|carpent\w*|appliances?|locksmith|garage door|pest|exterminat\w*)\b/i],
];

/**
 * The kind of purchase, from what the user asked for. The service named FIRST wins ("cleaning crew for
 * our catered dinner" is cleaning; "catering for a cleaning company" is catering); "move-out cleaning"
 * is cleaning. Anything unrecognized is "general".
 */
export function classify(r: Pick<IntakeInput, "what">): IntakeCategory {
  const what = r.what ?? "";
  if (/\bmove[- ]?(out|in)\s+clean/i.test(what)) return "cleaning";
  const hits = MATCHERS.map(([c, re]) => ({ c, at: re.exec(what)?.index ?? -1 })).filter((h) => h.at >= 0).sort((a, b) => a.at - b.at);
  return hits[0]?.c ?? "general";
}

export function profileFor(r: Pick<IntakeInput, "what">): CategoryProfile {
  return CATEGORY_PROFILES[classify(r)];
}

// ───────────────────────────── intake gaps ─────────────────────────────

export interface IntakeGaps {
  category: IntakeCategory;
  label: string;
  /** Essentials the request doesn't have yet: ask the user before contacting anyone. */
  missing: IntakeQuestion[];
  /** The missing essentials no "go ahead anyway" can skip (what the job is, and where): nothing is sent without them. */
  floor: IntakeQuestion[];
  /** Optional details that change the price and aren't given yet (at most 5). */
  helpful: IntakeQuestion[];
  /** One line: the brief as it stands. */
  brief: string;
  complete: boolean;
}

const strip = ({ key, question, field }: Essential): IntakeQuestion => ({ key, question, field });

/**
 * The minimum a business must be told before Haggle contacts it, even when the user says to go ahead
 * without the rest: what the job is and where it is. Asking a business to quote without them wastes its
 * time and gets no usable reply (timing and the optional details can be left to the business).
 */
export const FLOOR_KEYS: ReadonlySet<string> = new Set(["where", "problem", "scope", "spec", "route", "headcount"]);

/** What a business needs to quote that this request doesn't say yet, and the optional details worth asking for in the same message. */
export function intakeGaps(r: IntakeInput): IntakeGaps {
  const p = profileFor(r);
  const missing = p.essentials.filter((e) => !e.has(r)).map(strip);
  const helpful = p.helpful.filter((e) => !e.has(r)).slice(0, 5).map(strip);
  const floor = missing.filter((q) => FLOOR_KEYS.has(q.key));
  return { category: p.id, label: p.label, missing, floor, helpful, brief: briefLine(r), complete: missing.length === 0 };
}

/** "lunch catering · 40 people · 2026-10-22 12:00 · YC office, San Francisco · 12 vegetarian meals" (only what is known). */
export function briefLine(r: IntakeInput): string {
  const qty = filled(r.quantity) ? `${r.quantity}${typeof r.quantity === "number" ? ` ${r.unit ?? "people"}` : ""}` : null;
  const when = [r.date, r.date_until && r.date_until !== r.date ? `to ${r.date_until}` : null, r.time].filter(filled).join(" ") || null;
  const where = [r.venue, r.area].filter(filled).join(", ") || null;
  const extra = [...(r.details ?? []).map((d) => `${d.label}: ${d.value}`), ...(r.requirements ?? []).map((q) => q.text)].slice(0, 4);
  return [r.what, qty, when, where, ...extra].filter(filled).join(" · ").slice(0, 300);
}

// ───────────────────────────── vendor asks ─────────────────────────────

/** Does one of the request's own ask[] answers already cover this vendor ask? */
function askedAlready(a: VendorAsk, own: { key: string; label: string }[]): boolean {
  const re: Record<string, RegExp> = {
    total: /\b(total|price|cost|quote)\b/i, per_unit: /\bper\b|\bunit\b|\brate\b/i, deposit: /\bdeposit\b/i, availability: /\b(availab\w*|earliest|date|start)\b/i,
    cancellation: /\bcancel\w*/i, valid_until: /\bvalid\w*|expir\w*/i, included: /\binclud\w*/i, pricing_basis: /\b(hourly|rate|flat)\b/i, arrival: /\b(arriv\w*|earliest)\b/i,
    callout_fee: /\b(call[- ]?out|trip|diagnostic)\b/i, warranty: /\bwarrant\w*/i, turnaround: /\bturnaround|lead time\b/i,
  };
  const r = re[a.key] ?? new RegExp(`\\b${a.key.replace(/_/g, "[ _]")}\\b`, "i");
  return own.some((f) => r.test(f.key.replace(/_/g, " ")) || r.test(f.label));
}

/**
 * What we need back from every business for this request, in priority order: the itemized all-in
 * total, the category's own asks, then what's included, the per-unit price, the deposit and payment
 * terms, availability and the cancellation policy. Asks the request's own ask[] already covers are
 * left out (those are asked by their own labels). Calls and texts ask from this list; the first email
 * asks only firstEmailAsks.
 */
export function vendorAsksFor(r: IntakeInput): VendorAsk[] {
  const p = profileFor(r);
  const { first, rest } = commonAsks(r);
  const critical = new Set(p.critical);
  const all = [first, ...p.vendorAsks, ...rest].map((a) => (a.covers && critical.has(a.covers) ? { ...a, critical: true } : a));
  const own = r.ask ?? [];
  return own.length ? all.filter((a) => !askedAlready(a, own)) : all;
}

/**
 * The first email's asks after "your all-in price (<allIn>)": any deposit, then at most two short
 * asks the price can't carry. Which of the flexible days works (a date range), when they could do it
 * (an undated job with no timing ask), and the category's one first ask (a repair's earliest arrival,
 * a mover's hourly rate). Asks the request's own ask[] covers are left out. Everything else (the menu,
 * the per-person price, the cancellation policy) waits for a follow-up, and only if the reply leaves it out.
 */
export function firstEmailAsks(r: IntakeInput): { allIn: string; asks: string[]; delivered: boolean } {
  const p = profileFor(r);
  const own = r.ask ?? [];
  const covered = (key: string) => own.length > 0 && askedAlready({ key, text: "", voice: "", short: "" }, own);
  const asks: string[] = [];
  if (filled(r.date_until) && r.date_until !== r.date) asks.push("which of those days you can do");
  else if (!filled(r.date) && !filled(r.time) && !covered("availability") && p.firstAsk?.key !== "arrival") asks.push("when you could do it");
  if (p.firstAsk && !covered(p.firstAsk.key)) asks.push(p.firstAsk.text);
  if (!covered("deposit")) asks.unshift("any deposit you need");
  return { allIn: p.allIn, asks: asks.slice(0, 3), delivered: p.id === "catering" };
}

/** A parsed reply's terms, as far as intake needs them (QuoteRecord satisfies it). */
export interface ReplyTerms {
  deposit_cents: number | null;
  terms?: { deposit_terms: string | null; cancellation: string | null; exclusions: string[] };
  /** Catering: what the reply lists (an empty list = it said nothing about the menu). */
  menu_items?: string[];
  price_per_head_cents?: number | null;
  total_cents?: number | null;
}

/**
 * What this reply left out that matters, as plain asks for the one follow-up (they ride along only
 * with a follow-up that goes out anyway): the deposit and payment terms (what gets paid on approval
 * depends on it), and for events and moves the cancellation policy. For catering, the terms the first
 * email no longer asks for: the cancellation policy for a dated event, what the price includes when the
 * reply lists no menu, and the price per person when it gives neither a menu nor a total. Empty when the reply said them
 * (or the request's own ask[] covers them).
 */
export function criticalGaps(r: IntakeInput, reply: ReplyTerms): string[] {
  const out: string[] = [];
  const asks = vendorAsksFor(r);
  for (const a of asks.filter((x) => x.critical)) {
    // Short enough for a 159-char text, plain enough for an email sentence.
    if (a.covers === "deposit" && reply.deposit_cents === null && !reply.terms?.deposit_terms) out.push("any deposit and when it's due");
    if (a.covers === "cancellation" && !reply.terms?.cancellation) out.push("your cancellation policy");
  }
  if (classify(r) === "catering") {
    const has = (key: string) => asks.some((a) => a.key === key);
    const noMenu = reply.menu_items !== undefined && reply.menu_items.length === 0;
    if (filled(r.date) && has("cancellation") && !reply.terms?.cancellation) out.push("your cancellation policy");
    if (noMenu && has("menu")) out.push("what the price includes (menu, delivery, setup)");
    // The price per person matters only when the reply gives neither a menu nor a total to divide.
    if (noMenu && has("per_unit") && reply.price_per_head_cents === null && reply.total_cents === null) out.push(`the price per ${(r.unit ?? "person").replace(/^people$/, "person").replace(/s$/, "")}`);
  }
  return out;
}

/** The text ask for a 159-char iMessage, longest first (callers take the first that fits). */
export function imessageAskVariants(r: IntakeInput): string[] {
  const asks = vendorAsksFor(r);
  const own = new Set(profileFor(r).vendorAsks.map((a) => a.key));
  const cat = asks.filter((a) => own.has(a.key)).map((a) => a.short);
  const crit = asks.filter((a) => a.critical && a.key !== "total").map((a) => a.short);
  const lead = cat[0];
  return [
    ...(lead ? [`All-in total, ${lead}, ${crit.join(", ")}?`] : []),
    `All-in total, ${crit.join(", ")}?`,
    ...(lead ? [`All-in total + ${lead}?`] : []),
    "All-in total + deposit?",
    "Total + deposit?",
  ].map((s) => s.replace(/, \?$/, "?").replace(/ {2,}/g, " ")).filter((s, i, all) => all.indexOf(s) === i);
}
