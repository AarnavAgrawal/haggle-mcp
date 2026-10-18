/** Small, pure helpers shared by the brain: categories, areas, money and stats. */

const CATEGORY_WORDS: [string, string[]][] = [
  ["catering", ["cater", "lunch", "dinner", "breakfast", "brunch", "meal", "food", "buffet", "snack"]],
  ["printing", ["print", "flyer", "banner", "poster", "sticker"]],
  ["moving", ["mover", "moving", "relocat"]],
  ["cleaning", ["clean", "janitor"]],
];

/** Normalized category for learning: "Lunch catering for 40" → "catering". */
export function categoryOf(req: { what: string; category?: string | undefined }): string {
  const raw = (req.category ?? req.what).toLowerCase();
  for (const [category, words] of CATEGORY_WORDS) {
    if (words.some((w) => raw.includes(w))) return category;
  }
  return raw.trim().split(/\s+/).slice(-1)[0] ?? raw;
}

const AREA_ALIASES: Record<string, string> = {
  sf: "san francisco",
  "s.f.": "san francisco",
  "san francisco": "san francisco",
  "san francisco, ca": "san francisco",
  "sf bay area": "san francisco",
  "bay area": "san francisco",
  // SF venues and neighborhoods people name instead of the city ("YC HQ", "SoMa office").
  yc: "san francisco",
  "y combinator": "san francisco",
  soma: "san francisco",
  "mission district": "san francisco",
  "mission bay": "san francisco",
  "the mission": "san francisco",
  fidi: "san francisco",
  "financial district": "san francisco",
  dogpatch: "san francisco",
  "hayes valley": "san francisco",
  presidio: "san francisco",
  "union square": "san francisco",
  nyc: "new york",
  "new york city": "new york",
  "new york, ny": "new york",
};

const AREA_LABELS: Record<string, string> = { "san francisco": "SF", "new york": "NYC" };

/** Longest alias first, so "sf bay area" wins over "bay area" and "san francisco, ca" over "sf". */
const ALIASES_BY_LENGTH = Object.keys(AREA_ALIASES).sort((a, b) => b.length - a.length);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "YC HQ, 680 Folsom St, San Francisco, CA 94107" → "san francisco"; unknown places pass through. */
export function normalizeArea(area: string | undefined): string | undefined {
  if (!area) return undefined;
  const a = area.trim().toLowerCase().replace(/\s+/g, " ");
  if (AREA_ALIASES[a]) return AREA_ALIASES[a];
  // A venue or street address that names a known city anywhere in it.
  const hit = ALIASES_BY_LENGTH.find((k) => new RegExp(`(^|[^a-z])${escape(k)}([^a-z]|$)`).test(a));
  return hit ? AREA_ALIASES[hit] : a.replace(/,\s*[a-z]{2}$/, "");
}

export function areaLabel(area: string | undefined): string {
  if (!area) return "your area";
  return AREA_LABELS[area] ?? area.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function unitLabel(category: string): string {
  return category === "catering" ? "person" : "unit";
}

export const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function mean(values: number[]): number | undefined {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
}

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** "$1,035" or "$24.88". */
export function money(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** "$24–28" (whole dollars, widened outward so $24.50 stays inside) or "$27" for a single price. */
export function moneyRange(low: number, high: number): string {
  const lo = Math.floor(low);
  const hi = Math.ceil(high);
  return lo === hi ? `$${lo}` : `$${lo}–${hi}`;
}

/** Flags that mean "never recommend or pay this business". */
export const SAFETY_FLAGS = new Set(["external_payment_link", "prompt_injection"]);
