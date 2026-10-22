// Evaluation corpus types (WS-F). Every case is SIMULATED: hand-written vendor replies in the shapes
// real mail clients produce, labelled by hand. Nothing here is customer data or live traffic.
import type { Request } from "../src/contract.ts";

/** How the vendor's mail client lays out a reply around the quoted message (see clients.ts). */
export type ClientStyle =
  | "plain" | "gmail" | "gmail_wrapped" | "gmail_fr" | "outlook_header" | "outlook_rule" | "outlook_mobile"
  | "ios_mail" | "apple_mail" | "yahoo" | "bottom_post";

/** What the reply quotes below the vendor's own words. */
export type Quoted = "rfq" | "counter" | "none";

/** What a correct buyer agent does with this reply. */
export type Outcome =
  | "quote" // a priced quote that can be compared
  | "decline" // the business can't do it
  | "question" // the business needs an answer before it can quote
  | "unsafe_payment" // asks to be paid outside the thread (link, bank, Zelle): never payable
  | "unsafe_injection" // instructions aimed at the AI: never followed, never approvable
  | "opt_out" // asked not to be contacted
  | "no_new_price"; // replied without a new figure (e.g. "can't go lower")

export interface FeeLabel {
  label: string;
  amount_usd: number;
  /** True when the stated total already includes it. */
  included: boolean;
}

/** Ground truth for one reply, in USD. `null` = the reply doesn't establish it. */
export interface Labels {
  outcome: Outcome;
  available: boolean;
  /** The all-in total the buyer would pay (food + delivery + fees + tax), or null when the reply doesn't fix one. */
  total_usd: number | null;
  deposit_usd: number | null;
  /** Delivery included or priced (true), refused / pick-up only (false), unstated (null). */
  delivery: boolean | null;
  fees: FeeLabel[];
  tax: "included" | "added_on_top" | "not_mentioned";
  /** Vegetarian meals the business offered (null = not stated). */
  veg_count: number | null;
  /** Meets every hard requirement (true), fails one (false), unknown from this reply (null). */
  compliant: boolean | null;
  /** Figures that appear ONLY in the quoted text (our RFQ or counter), so reading one is a leak. */
  leak_values_usd?: number[];
  /** The reply holds a blocking question for the buyer. */
  question?: boolean;
}

export interface PdfSpec {
  filename: string;
  /** One array of text lines per page. */
  pages: string[][];
}

export interface CorpusCase {
  id: string;
  description: string;
  /** "own" (written for this corpus) or "fixture:<file>" (reused read-only from fixtures/). */
  origin: string;
  vendor: { name: string; email: string };
  client: ClientStyle;
  quoted: Quoted;
  /** The vendor's own words (the part above or below the quote). */
  own: string;
  subject?: string;
  pdfs?: PdfSpec[];
  /** Raw files (e.g. a fixture PDF or quote.json); quote.json `job_id` is filled in at run time. */
  files?: { filename: string; contentType: string; data: Uint8Array; jobScoped?: boolean }[];
  labels: Labels;
  /** Engine features the case exercises, for the report. */
  tags: string[];
}

/** The request every corpus case answers (the offsite-lunch scenario, dated relative to the eval clock). */
export interface CorpusRequest {
  request: Request;
  budget_usd: number;
}
