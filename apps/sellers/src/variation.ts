/**
 * Per-conversation variety. Each new thread draws its own terms (price, delivery fee, deposit,
 * minimum, negotiation room, first question, menu, mood) within the persona's character, so no two
 * deals look alike. The draw is stored in the thread state: one conversation stays consistent.
 * Each persona keeps the trait Haggle must catch (Golden Grill's vegetarian shortfall, Harbor's
 * page-2 deposit, QuickQuote's pay-now bait, Sunset's question first).
 */
import type { Persona } from "./personas.ts";

export interface Terms {
  perHead: number;
  deliveryUsd: number;
  depositPct?: number;
  minimumUsd?: number;
  vegetarianCap?: number;
  question?: string;
  addOn?: { label: string; perHead: number };
  negotiation: { dropPct: number; needsCompetingQuote: boolean };
  menu: string[];
  vegItem: string;
  mood: string;
}

export type Rng = () => number;

const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
const between = (rng: Rng, lo: number, hi: number) => lo + rng() * (hi - lo);
/** Prices end in a quarter, like a real menu. */
const quarter = (n: number) => Math.round(n * 4) / 4;
const chance = (rng: Rng, p: number) => rng() < p;
const round2 = (n: number) => Math.round(n * 100) / 100;

function sample<T>(rng: Rng, xs: readonly T[], n: number): T[] {
  const pool = [...xs];
  const out: T[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]!);
  return out;
}

const MOODS = [
  "Today you're upbeat and a little chatty.",
  "Today you're slammed and keep it brief.",
  "Today you're relaxed and thorough.",
  "Today you're eager for the business and say so.",
  "Today you're matter-of-fact.",
  "Today you mention one dish you're proud of.",
];

const MENUS: Record<string, { menu: string[]; veg: string[] }> = {
  bay_catering: {
    menu: ["Mediterranean buffet", "Herb chicken skewers", "Falafel and hummus", "Lemon orzo salad", "Chicken shawarma bowls", "Grilled vegetable platter"],
    veg: ["vegetarian grain bowls", "falafel plates (vegetarian)", "roasted vegetable bowls"],
  },
  harbor_table: {
    menu: ["Family-style lunch", "Grilled salmon", "Lemon-herb chicken", "Roasted fingerling potatoes", "Seasonal greens", "Braised short rib"],
    veg: ["mushroom risotto (vegetarian)", "eggplant parmesan (vegetarian)", "wild mushroom gnocchi (vegetarian)"],
  },
  mission_eats: {
    menu: ["Taco bar", "Carnitas", "Rajas con crema", "Pollo asado", "Rice and beans", "Chips and salsa"],
    veg: ["veggie plates", "bean and cheese burritos", "grilled veggie tacos"],
  },
  golden_grill: {
    menu: ["BBQ brisket", "Pulled pork", "Mac and cheese", "Coleslaw", "Smoked chicken", "Cornbread"],
    veg: ["veggie burger plates", "grilled portobello plates", "BBQ jackfruit sandwiches"],
  },
  sunset_kitchen: {
    menu: ["Pasta bar", "Caesar salad", "Rosemary focaccia", "Chicken piccata", "Caprese skewers", "Lemon bars"],
    veg: ["pesto pasta (vegetarian)", "baked ziti (vegetarian)", "roasted vegetable lasagna"],
  },
  quickquote_deli: {
    menu: ["Sandwich platters", "Chips", "Cookies", "Wrap platters", "Pasta salad", "Fruit cups"],
    veg: ["veggie wraps", "caprese sandwiches", "hummus wraps"],
  },
};

const SUNSET_QUESTIONS = [
  { question: "Happy to quote! Do you need plates, cutlery and napkins, or just the food?", label: "plates, cutlery and napkins", perHead: [1.25, 2] },
  { question: "Love to help! Want us to add a dessert tray (cookies and brownies), or just lunch?", label: "dessert tray", perHead: [2.5, 4] },
  { question: "Sounds fun! Should we stay to set up and serve, or is a drop-off fine?", label: "on-site setup and serving", perHead: [2, 3] },
] as const;

const HARBOR_QUESTIONS = [
  "Thank you for thinking of us. Before I prepare the quote: what time would you like the food delivered, and is there a loading area?",
  "We'd be glad to cater. Could you confirm the delivery time so I can check our kitchen schedule?",
];

/** The persona's own numbers, with no variety (tests, and SELLERS_VARY=0). */
export function baseTerms(p: Persona): Terms {
  return compact({
    perHead: p.perHead,
    deliveryUsd: p.deliveryUsd,
    depositPct: p.depositPct,
    minimumUsd: p.minimumUsd,
    vegetarianCap: p.vegetarianCap,
    question: p.question,
    addOn: p.addOn,
    negotiation: p.negotiation,
    menu: p.menu,
    vegItem: p.vegItem,
    mood: "",
  });
}

/** Fresh terms for one conversation, in character. */
export function drawTerms(p: Persona, rng: Rng = Math.random): Terms {
  const menus = MENUS[p.key];
  const t: Terms = {
    ...baseTerms(p),
    perHead: quarter(p.perHead * between(rng, 0.88, 1.12)),
    menu: menus ? sample(rng, menus.menu, 2 + Math.floor(rng() * 2)) : p.menu,
    vegItem: menus ? pick(rng, menus.veg) : p.vegItem,
    mood: pick(rng, MOODS),
  };

  switch (p.key) {
    case "bay_catering":
      t.depositPct = pick(rng, [0.1, 0.15, 0.2]);
      t.deliveryUsd = chance(rng, 0.2) ? 25 : 0;
      t.negotiation = { dropPct: chance(rng, 0.5) ? 0 : round2(between(rng, 0.03, 0.07)), needsCompetingQuote: true };
      break;
    case "harbor_table":
      t.depositPct = pick(rng, [0.25, 0.3, 0.35]); // always on page 2 of the PDF
      t.minimumUsd = Math.round(between(rng, 350, 500) / 25) * 25;
      t.negotiation = { dropPct: round2(between(rng, 0.05, 0.12)), needsCompetingQuote: true };
      if (chance(rng, 0.25)) t.question = pick(rng, HARBOR_QUESTIONS);
      break;
    case "mission_eats":
      t.negotiation = { dropPct: round2(between(rng, 0.03, 0.08)), needsCompetingQuote: true };
      break;
    case "golden_grill":
      t.vegetarianCap = 4 + Math.floor(rng() * 5); // 4..8: still short of most asks
      t.deliveryUsd = chance(rng, 0.35) ? pick(rng, [30, 40, 50]) : 0;
      t.depositPct = pick(rng, [0.15, 0.2, 0.25]); // real caterers hold the date with a deposit
      t.negotiation = { dropPct: chance(rng, 0.6) ? 0 : round2(between(rng, 0.03, 0.05)), needsCompetingQuote: true };
      break;
    case "sunset_kitchen": {
      const q = pick(rng, SUNSET_QUESTIONS);
      t.question = q.question;
      t.addOn = { label: q.label, perHead: quarter(between(rng, q.perHead[0], q.perHead[1])) };
      t.depositPct = pick(rng, [0.1, 0.15, 0.2]);
      t.negotiation = { dropPct: round2(between(rng, 0.03, 0.08)), needsCompetingQuote: chance(rng, 0.3) };
      break;
    }
    case "quickquote_deli":
      t.negotiation = { dropPct: 0, needsCompetingQuote: true };
      break;
  }
  return t;
}

/** The persona as it behaves in one conversation. */
export function withTerms(p: Persona, t: Terms): Persona {
  return compact({
    ...p,
    perHead: t.perHead,
    deliveryUsd: t.deliveryUsd,
    depositPct: t.depositPct,
    minimumUsd: t.minimumUsd,
    vegetarianCap: t.vegetarianCap,
    question: t.question,
    addOn: t.addOn,
    negotiation: t.negotiation,
    menu: t.menu,
    vegItem: t.vegItem,
    style: t.mood ? `${p.style} ${t.mood}` : p.style,
  });
}

function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
