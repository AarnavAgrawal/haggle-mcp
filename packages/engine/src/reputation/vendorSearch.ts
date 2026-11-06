// PURE: how wide a listing search looks, and how its results are labelled and ordered.
//
// A business that can do the job often isn't tagged for it: Domino's and Pizza Hut aren't caterers but
// take bulk orders, and a handyman fixes a leak without being a plumber. A search that only asks for the
// kind of work never sees them, so each kind also asks for its related trades (the providers run the
// queries; fit.ts still drops what doesn't do the work). Work with no vocabulary is searched as asked.
//
// Honesty rules:
// - A related business is "adjacent", never called a specialist: it may do the work, and the quote
//   request is what finds out.
// - A price tier comes from a listing signal or is absent. Amazon listings carry no price, so its tier is
//   read from the kind of place (fast food, fine dining). It is a rough guide, never a quote.
// - Preferences steer the order and never remove a business; with none, the list spans the range.
import { fitsCategory, isSpecialist, kindOf, searchPhrase } from "./fit.ts";
import type { FoundBusiness } from "./places.ts";

export type PriceRange = "budget" | "mid" | "upscale";

/** What the user would like. Soft: it orders results, and any field may be absent. */
export interface SearchPreferences {
  /** A cuisine label from cuisineOf, else the user's own word ("ethiopian"). */
  cuisine?: string;
  price?: PriceRange;
}

/** Cuisines Haggle recognizes. `food` is Amazon's food type id, where one is published. Barbecue comes first: Amazon's id for it also says "american". */
const CUISINES: { label: string; food?: string; words: RegExp }[] = [
  { label: "barbecue", food: "american-barbecue/southern", words: /\b(bbq|barbecue|barbeque|smoke ?house)\b/ },
  { label: "pizza", food: "pizza", words: /\b(pizzas?|pizzeria)\b/ },
  { label: "mexican", food: "mexican", words: /\b(mexican|tacos?|taqueria|burritos?)\b/ },
  { label: "sandwich", food: "sandwich", words: /\b(sandwich\w*|subs|deli)\b/ },
  { label: "indian", food: "indian", words: /\b(indian|curry|dosa|tandoori)\b/ },
  { label: "chinese", food: "chinese", words: /\b(chinese|dim sum|szechuan|dumplings?)\b/ },
  { label: "japanese", food: "japanese", words: /\b(japanese|sushi|ramen|bento)\b/ },
  { label: "thai", food: "thai", words: /\bthai\b/ },
  { label: "korean", food: "korean", words: /\bkorean\b/ },
  { label: "vietnamese", food: "vietnamese", words: /\b(vietnamese|pho|banh mi)\b/ },
  { label: "italian", food: "italian", words: /\b(italian|pasta|trattoria)\b/ },
  { label: "mediterranean", food: "mediterranean", words: /\b(mediterranean|greek|falafel|shawarma|kebabs?)\b/ },
  { label: "seafood", food: "seafood", words: /\bseafood\b/ },
  { label: "american", food: "american", words: /\b(american|burgers?|hamburgers?)\b/ },
];

/** The cuisine a phrase names ("taco bar" -> mexican, "pizza_restaurant" -> pizza), or undefined. */
export function cuisineOf(text: string): string | undefined {
  const t = text.toLowerCase().replace(/[^a-z]+/g, " ");
  return CUISINES.find((c) => c.words.test(t))?.label;
}

/** Amazon's food type id for a cuisine label, or undefined: an unknown id fails the whole search. */
export function foodTypeId(cuisine: string): string | undefined {
  return CUISINES.find((c) => c.label === cuisine)?.food;
}

/** The price range a phrase names ("as cheap as possible" -> budget, "fancy" -> upscale), or undefined. */
export function priceRangeOf(text: string): PriceRange | undefined {
  // A negated word says nothing about the range it names: "nothing fancy" isn't upscale, "not cheap" isn't budget.
  const t = text.toLowerCase().replace(/\b(?:not|no|nothing|never|isn'?t|without)\s+(?:\w+\s+)?[\w-]+/g, " ").trim();
  if (/\b(cheap\w*|affordable|inexpensive|low[- ]?cost|bargain|economical|budget[- ]friendly)\b|^budget\b/.test(t)) return "budget";
  if (/\b(fancy|upscale|high[- ]?end|premium|luxury|fine dining|gourmet|elegant)\b/.test(t)) return "upscale";
  if (/\b(mid[- ]?range|mid[- ]?priced|moderate|moderately priced)\b|^mid$/.test(t)) return "mid"; // not "mid-day", or a "medium" pizza
  return undefined;
}

const NO_PREFERENCE = /^\s*(any|anything|none|no|no pref\w*|open|either|whatever|not sure|don'?t care)\b/i;

/** The user's preferences in a request: its Cuisine and Price range details, else what its own words name. */
export function preferencesFrom(r: { what: string; details?: { label: string; value: string }[] | null }): SearchPreferences {
  const detail = (label: RegExp) => (r.details ?? []).find((d) => label.test(d.label))?.value;
  const named = detail(/\b(cuisine|menu)\b/i); // not "food": a "Food allergies" detail isn't a cuisine
  const cuisine = named === undefined ? cuisineOf(r.what) : NO_PREFERENCE.test(named) ? undefined : cuisineOf(named) ?? named.trim().toLowerCase().slice(0, 40);
  const price = priceRangeOf(detail(/\bprice\b/i) ?? r.what);
  return { ...(cuisine ? { cuisine } : {}), ...(price ? { price } : {}) };
}

/** What a provider without category search needs to ask for to see restaurants at all, across the price range. */
const FOOD_TEXT = ["restaurants", "pizza delivery", "fine dining restaurants"];
/** Related trades to search as well (fit.ts keeps only the ones that do the work). */
const ALSO_SEARCH: Record<string, string[]> = {
  plumbing: ["handyman", "drain cleaning"],
  electrical: ["handyman", "electrical contractor"],
  repairs: ["handyman", "general contractor"],
  cleaning: ["janitorial service", "carpet cleaning"],
  moving: ["moving company", "truck rental"],
  printing: ["copy shop", "sign shop", "office supply store"],
  rentals: ["party supply store", "equipment rental"],
  photography: ["videographer", "photo studio"],
  entertainment: ["dj service", "live band"],
};

/** The text searches for a request, the main one first. A provider that also searches by category (Amazon) needn't ask for food by text. */
export function textQueries(category: string, prefs: SearchPreferences = {}, o: { categorySearch?: boolean } = {}): string[] {
  const kind = kindOf(category);
  const main = searchPhrase(category);
  const more = kind !== "catering" ? ALSO_SEARCH[kind ?? ""] ?? [] : [...(prefs.cuisine ? [`${prefs.cuisine} restaurant`] : []), ...(o.categorySearch ? [] : FOOD_TEXT)];
  return [...new Set([main, ...more])];
}

const TIER_BY_LEVEL: Record<string, PriceRange> = { PRICE_LEVEL_INEXPENSIVE: "budget", PRICE_LEVEL_MODERATE: "mid", PRICE_LEVEL_EXPENSIVE: "upscale", PRICE_LEVEL_VERY_EXPENSIVE: "upscale" };
const TIER_BY_TYPE: Record<string, PriceRange> = {
  fast_food: "budget", fast_food_restaurant: "budget", take_out_and_delivery_only: "budget", meal_takeaway: "budget",
  casual_dining: "mid", family_restaurant: "mid", fine_dining: "upscale", fine_dining_restaurant: "upscale",
};

/** A rough price tier from the listing, or undefined when it gives no signal. */
function priceTier(b: FoundBusiness): PriceRange | undefined {
  const level = b.price_level ? TIER_BY_LEVEL[b.price_level] : undefined;
  return level ?? [b.primary_type, ...b.types].map((t) => TIER_BY_TYPE[t ?? ""]).find(Boolean);
}

const ADJACENT_REASON = "restaurant, not listed as a caterer: may take large orders (Haggle asks first)";
const spaced = (t: string) => ` ${t.toLowerCase().replace(/[^a-z]+/g, " ").trim()} `;
/** Whole words: a "bar" preference isn't met by "Barbecue Barn". */
const matchesCuisine = (b: FoundBusiness, want: string) => b.cuisine === want || [b.name, b.primary_type, ...b.types].some((t) => spaced(t ?? "").includes(spaced(want)));

/** One listing with its fit, rough price tier and (food) cuisine, and the reasons rewritten to say so. */
function labelled(b: FoundBusiness, category: string, prefs: SearchPreferences): FoundBusiness {
  const kind = kindOf(category);
  const specialist = isSpecialist(category, b);
  const cuisine = kind === "catering" ? [...(b.food_types ?? []), b.primary_type, ...b.types, b.name].map((t) => cuisineOf(t ?? "")).find(Boolean) : undefined;
  const tier = priceTier(b);
  const next: FoundBusiness = { ...b, fit: specialist ? "specialist" : "adjacent", ...(cuisine ? { cuisine } : {}), ...(tier ? { price_tier: tier } : {}) };
  next.rank_reasons = [
    ...(specialist ? [] : [kind === "catering" ? ADJACENT_REASON : `related business, not listed for ${kind ?? category}: may do this work (Haggle asks first)`]),
    ...b.rank_reasons.filter((r) => specialist || !/^(weak match|matches "cater)/.test(r)),
    ...(tier ? [`rough price: ${tier} (from the listing, not a quote)`] : []),
    ...(prefs.cuisine && matchesCuisine(next, prefs.cuisine) ? [`matches your ${prefs.cuisine} preference`] : []),
    ...(prefs.price && tier === prefs.price ? [`matches your ${prefs.price} price preference`] : []),
  ];
  return next;
}

/** A preference beats anything else about a listing, so matches lead whatever their score. A named cuisine beats a price point: asking for cheap Mexican isn't asking for cheap pizza. */
const PREFERRED = { cuisine: 1.5, price: 1 };
/** What repeating a fit, a variety (cuisine, else listing category) or a price tier costs a listing: enough to bring in the next kind of option. */
const REPEAT = { fit: 0.12, variety: 0.12, price: 0.08 };

/** Best first, but each pick counts against more of the same; a dimension the user chose isn't spread. Deterministic: deal's confirm step re-runs the search. */
function spread(found: FoundBusiness[], prefs: SearchPreferences, count: number): FoundBusiness[] {
  const left = [...found];
  const out: FoundBusiness[] = [];
  const used = new Map<string, number>();
  const seen = (k: string) => used.get(k) ?? 0;
  const keys = (b: FoundBusiness) => [`fit:${b.fit}`, `variety:${b.cuisine ?? b.primary_type ?? "?"}`, `price:${b.price_tier ?? "?"}`];
  const value = (b: FoundBusiness) => {
    const [fit, variety, price] = keys(b) as [string, string, string];
    const wanted = (prefs.cuisine && matchesCuisine(b, prefs.cuisine) ? PREFERRED.cuisine : 0) + (prefs.price && b.price_tier === prefs.price ? PREFERRED.price : 0);
    return b.score + wanted - REPEAT.fit * seen(fit) - (prefs.cuisine ? 0 : REPEAT.variety * seen(variety)) - (prefs.price ? 0 : REPEAT.price * seen(price));
  };
  while (out.length < count && left.length) {
    let best = 0;
    for (let i = 1; i < left.length; i++) if (value(left[i]!) > value(left[best]!)) best = i;
    const [pick] = left.splice(best, 1);
    out.push(pick!);
    for (const k of keys(pick!)) used.set(k, seen(k) + 1);
  }
  return out;
}

/** Ranked listings -> the ones that do the work, labelled and spread across the range, at most `count`. A cuisine only means something for food. */
export function shapeResults(found: FoundBusiness[], category: string, count: number, prefs: SearchPreferences = {}): FoundBusiness[] {
  const steer = kindOf(category) === "catering" ? prefs : prefs.price ? { price: prefs.price } : {};
  return spread(found.filter((b) => fitsCategory(category, b)).map((b) => labelled(b, category, steer)), steer, count);
}

/** One line on what a search returned, for the agent and the user: "2 caterers, 4 restaurants · pizza, indian · budget to upscale". */
export function resultMix(found: Pick<FoundBusiness, "fit" | "cuisine" | "price_tier">[], category: string): string | null {
  if (!found.some((b) => b.fit)) return null;
  const food = kindOf(category) === "catering";
  const n = (fit: string) => found.filter((b) => b.fit === fit).length;
  const plural = (c: number, one: string, many: string) => `${c} ${c === 1 ? one : many}`;
  const cuisines = [...new Set(found.map((b) => b.cuisine).filter(Boolean))];
  const tiers = (["budget", "mid", "upscale"] as const).filter((t) => found.some((b) => b.price_tier === t));
  return [
    [n("specialist") ? plural(n("specialist"), food ? "caterer" : "specialist", food ? "caterers" : "specialists") : "", n("adjacent") ? plural(n("adjacent"), food ? "restaurant" : "related business", food ? "restaurants" : "related businesses") : ""].filter(Boolean).join(", "),
    cuisines.join(", "),
    tiers.length > 1 ? `${tiers[0]} to ${tiers.at(-1)}` : tiers[0] ?? "",
  ].filter(Boolean).join(" · ");
}
