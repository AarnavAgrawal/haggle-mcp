// The simulated restaurants (DESIGN.md §15). A TS module rather than JSON so it
// bundles into the server (SIM_ON_SERVER) and also runs from plain `node` scripts.

export interface Persona {
  id: string;
  name: string;
  apiKeyEnv: string;
  neverReplies?: boolean;
  pricePerHead?: [number, number];
  deliveryFee?: number;
  deposit?: { type: "flat" | "percent"; amount: number };
  replyDelaySeconds?: [number, number];
  negotiation?: { dropPercent: number };
  coversDietary?: boolean;
  style?: string;
  attachMenuPdf?: boolean;
  menu?: string[];
}

export const PERSONAS: Persona[] = [
  {
    id: "budget_bites",
    name: "Budget Bites",
    apiKeyEnv: "SIM_BUDGET_BITES_API_KEY",
    pricePerHead: [16, 19],
    deliveryFee: 0,
    deposit: { type: "flat", amount: 150 },
    replyDelaySeconds: [10, 25],
    negotiation: { dropPercent: 0 },
    coversDietary: true,
    style:
      "Terse and sloppy, like a busy owner texting from the kitchen. Lowercase, abbreviations like 'ppl' and 'lmk', approximate wording like '~$18/head'. No sign-off. Two or three short lines total.",
  },
  {
    id: "le_petit_four",
    name: "Le Petit Four",
    apiKeyEnv: "SIM_LE_PETIT_FOUR_API_KEY",
    pricePerHead: [34, 42],
    deliveryFee: 75,
    deposit: { type: "percent", amount: 30 },
    replyDelaySeconds: [120, 180],
    negotiation: { dropPercent: 0 },
    coversDietary: true,
    style:
      "Formal and polished French bistro. Full sentences, a courteous greeting and sign-off from 'Chef Amélie'. Lists a four-course sample menu and states the quote is valid for 7 days.",
    attachMenuPdf: true,
    menu: [
      "Amuse-bouche: gougeres",
      "Starter: leek and goat cheese tart (vegetarian)",
      "Main: coq au vin, or mushroom bourguignon (vegetarian)",
      "Dessert: tarte Tatin",
      "Service: staffed buffet, linens included",
    ],
  },
  {
    id: "taqueria_sol",
    name: "Taqueria Sol",
    apiKeyEnv: "SIM_TAQUERIA_SOL_API_KEY",
    pricePerHead: [22, 25],
    deliveryFee: 40,
    deposit: { type: "flat", amount: 200 },
    replyDelaySeconds: [30, 60],
    negotiation: { dropPercent: 10 },
    coversDietary: true,
    style:
      "Friendly and upbeat family taqueria. Casual but complete: per-person price, delivery fee, deposit, and a short taco-bar menu with vegetarian options. Signs off 'Gracias, Marisol'.",
  },
  {
    id: "golden_wok",
    name: "Golden Wok",
    apiKeyEnv: "SIM_GOLDEN_WOK_API_KEY",
    neverReplies: true,
  },
];
