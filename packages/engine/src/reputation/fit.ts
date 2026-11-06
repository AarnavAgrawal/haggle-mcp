// Does a found listing actually do the kind of work asked for? Listing search is fuzzy text: a
// "catering" search near SoMa returned an architecture firm whose listing carries a secondary
// catering tag (primary: engineering_and_scientific_services), and a "plumbing" search returns a
// plumbing SUPPLY store (primary: b2b_sales_and_services). Neither may be emailed for the job.
//
// Rule: a listing fits when its PRIMARY category (Amazon Categories[Primary], Google primaryType)
// fits the request's kind of work. Secondary tags never qualify a business on their own. A listing
// with no primary category falls back to its other categories and its name. A related trade also fits
// (a handyman for plumbing, a copy shop for printing), labelled as such by isSpecialist. A kind of work
// with no vocabulary here can't be judged, so the listing search's own results stand.

/** Words a primary category may contain for each kind of work: prefix match on its words; "x$" = the exact word; "a_b" = substring. */
const KINDS: Record<string, string[]> = {
  catering: [
    "cater", "restaurant", "food", "baker", "cafe", "coffee", "deli$", "delicatessen", "eatery", "meal", "chef", "bistro", "diner", "grill",
    "bbq", "barbecue", "pizza", "taco", "taqueria", "burrito", "sushi", "sandwich", "bagel", "donut", "dessert", "cake", "pastry", "juice", "tea_house",
    "lunch", "dinner", "breakfast", "brunch", "buffet", "snack", "bento", "dining", "take_out", // fine_dining, casual_dining, take_out_and_delivery_only
  ],
  plumbing: ["plumb", "rooter", "drain", "sewer", "water_heater"],
  electrical: ["electric"],
  repairs: ["repair", "handyman", "contractor", "maintenance", "plumb", "electric"], // not home_improvement: mostly hardware stores
  cleaning: ["clean", "janitor", "maid", "housekeep"],
  moving: ["mover", "moving", "relocation"],
  printing: ["print", "sign", "copy", "copies"],
  rentals: ["rental", "party", "event", "tent"],
  photography: ["photo", "video"],
  entertainment: ["entertain", "dj", "music", "band", "event", "perform"],
};

/**
 * Related trades that may do the work without being listed for it: they fit, but never count as
 * specialists. Same match rules as KINDS. Named narrowly, since whatever fits can be called: "studio"
 * would take in a yoga studio, "contractor" a roofer.
 */
const RELATED: Record<string, string[]> = {
  plumbing: ["handyman", "general_contractor", "trade_contractor", "hvac"],
  electrical: ["handyman", "general_contractor", "trade_contractor"],
  repairs: ["hvac"],
  moving: ["truck_rental", "junk_removal", "freight"],
  printing: ["office_supply", "stationery", "shipping_center", "graphic_design"],
  rentals: ["equipment_rental", "furniture_rental", "audio_visual"],
};

/**
 * Primary categories a kind of work never accepts, even when a vocabulary word matches: Haggle's
 * "repairs" are home repairs, and a "repairs" search near SoMa returned only auto shops (car_repair).
 */
const NOT: Record<string, string[]> = {
  repairs: ["car", "auto", "automotive", "vehicle", "tire", "towing", "emission", "windshield", "motorcycle", "boat", "smog", "collision", "muffler", "brake"],
};

const STOP = new Set(["and", "or", "the", "of", "for", "an", "other", "services", "service", "company", "inc", "llc", "co"]);
const wordsOf = (s: string) => s.toLowerCase().replace(/&/g, " ").split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
const stem = (w: string) => w.slice(0, 5);
const plain = (terms: string[]) => terms.filter((t) => !t.includes("_"));
const wordHit = (w: string, t: string) => (t.endsWith("$") ? w === t.slice(0, -1) : w.startsWith(t));

/** The kind of work a request category names ("catering", "plumber" -> plumbing, "taco truck" -> catering), or null when unknown. */
export function kindOf(category: string): string | null {
  const c = category.trim().toLowerCase();
  if (KINDS[c]) return c;
  const ws = wordsOf(c);
  const kinds = Object.keys(KINDS);
  // The kind a word names ("photographer" -> photography) beats one its vocabulary shares ("event").
  return kinds.find((kind) => ws.some((w) => stem(w) === stem(kind)))
    ?? kinds.find((kind) => ws.some((w) => plain(KINDS[kind]!).some((t) => wordHit(w, t))))
    ?? null;
}

/**
 * The words to search listings with. A bare "rentals" finds a hot-tub spa near Oakland while "event
 * rentals" finds party and event rental companies (Haggle's rentals are tents, furniture, equipment for
 * events); every other category is searched as given.
 */
const SEARCH_AS: Record<string, string> = { rentals: "event rentals" };
export function searchPhrase(category: string): string {
  const c = category.trim();
  return SEARCH_AS[c.toLowerCase()] ?? c;
}

/** The vocabulary for a request's kind of work, or null when unknown. */
export function kindTerms(category: string): string[] | null {
  const k = kindOf(category);
  return k ? KINDS[k]! : null;
}

/** Does `label` ("catering_and_other_food_services", a business name) contain one of the terms? */
function matches(label: string, terms: string[]): boolean {
  const snake = label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (terms.some((t) => t.includes("_") && snake.includes(t))) return true;
  const p = plain(terms);
  return wordsOf(label).some((w) => p.some((t) => wordHit(w, t)));
}

export interface ListingKind {
  name: string;
  primary_type?: string;
  types?: string[];
}

/** Is this listing a business that does `category`? An empty category accepts everything (a lookup, not a search). Pure. */
export function fitsCategory(category: string, b: ListingKind): boolean {
  if (!category.trim()) return true;
  const kind = kindOf(category);
  if (!kind) return true;
  const terms = [...KINDS[kind]!, ...(RELATED[kind] ?? [])];
  const excluded = (label: string) => !!NOT[kind] && wordsOf(label).some((w) => NOT[kind]!.includes(w));
  if (b.primary_type) return !excluded(b.primary_type) && matches(b.primary_type, terms);
  return !excluded(b.name) && ((b.types ?? []).some((t) => !excluded(t) && matches(t, terms)) || matches(b.name, terms));
}

/** Does the listing show this work itself, rather than a related trade? Catering takes the whole word: "Caterina's Trattoria" is a restaurant. */
export function isSpecialist(category: string, b: ListingKind): boolean {
  const kind = kindOf(category);
  const labels = [b.name, b.primary_type ?? "", ...(b.types ?? [])];
  if (kind === "catering") return labels.some((t) => /\b(catering|caterers?)\b/.test(t.toLowerCase().replace(/[^a-z]+/g, " ")));
  const terms = kind ? KINDS[kind]! : wordsOf(category).map(stem);
  return labels.some((t) => matches(t, terms));
}
