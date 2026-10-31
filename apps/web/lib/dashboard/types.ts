// What the dashboard reads from the Haggle MCP tools. The core view types come from @haggle/core;
// the server's additions (apps/mcp/src/views.ts DealBoardPlus, list_deals rows) are mirrored here as
// optional fields, so a field the server leaves out simply isn't rendered.
import type { Conversation, DealBoardOrEmpty, Identity, Quote } from "@haggle/core";

export type Mode = "mock" | "live";

/** A board quote: a total the business never stated is null (unknown, never $0). */
export type BoardQuote = Omit<Quote, "total_usd"> & { total_usd: number | null; total_known?: boolean };

/** get_quotes structuredContent (DealBoardPlus, compact): the fields the dashboard renders. */
export type DealBoardView = Omit<DealBoardOrEmpty, "quotes"> & {
  quotes: BoardQuote[];
  job_id?: string;
  request_details?: {
    what: string; headcount?: number; when: string; place: string; date?: string; time?: string;
    requirements: string[]; budget_usd: number | null; budget_source?: "request" | "settings_default";
  };
  payment_ceiling_usd?: number;
  payments_enabled?: boolean;
  quote_status?: Record<string, { approvable: boolean; approximate?: boolean; block?: { code: string; reason: string }; price_note?: string }>;
  best_value_quote_id?: string;
  recommendation_note?: string;
  best_available_quote_id?: string;
  compliance?: Record<string, { status: "compliant" | "unconfirmed" | "noncompliant"; issues: { code: string; text: string }[]; assumed?: string[] }>;
  freshness?: Record<string, { stale: boolean; good_until: string; valid_until?: string | null; reconfirmation?: "requested" }>;
  purchase?: {
    stage: string; booked: boolean; money_verified: boolean; amount_usd: number; total_usd: number;
    instructions?: { text: string; untrusted: true; has_link: boolean };
    vendor_reply?: { text: string; untrusted: true; has_link: boolean };
    summary: string; next: string; order?: string; must_haves?: string; confirm_only?: true;
  };
  value?: { explanation: { winner: string; others: { quote_id: string; text: string }[] } | null };
  stages?: Record<string, { stage: string; negotiation: "none" | "countered" | "vendor_revised" | "held_firm"; first_total_usd?: number; current_total_usd?: number; saved_usd?: number }>;
  terms?: Record<string, { fees?: { label: string; amount_usd?: number; included: boolean | null; excerpt: string }[]; deposit_terms?: string | null; cancellation?: string | null; exclusions?: string[] }>;
  callbacks?: { business_id: string; business: string; their_total_usd: number; basis_total_usd: number; basis_business: string; why: string }[];
  not_contacted?: { business: string; channel: string; reason: string }[];
  /** Quote ids that counteroffers cited as estimates ("about $1,200"). */
  negotiation_estimates?: string[];
  warnings?: string[];
  setup?: { ready: number; total: number; blockers: { vendor: string; channel: string; reason: string; fix: string }[] };
  vendor_contact?: Record<string, { status: string; detail?: string }>;
  selection?: Record<string, { status: "recommended" | "selectable" | "not_selectable"; reason: string }>;
};

/** One list_deals row. */
export interface DealRow {
  job_id: string;
  what: string;
  state: string;
  quantity?: number;
  unit?: string;
  date?: string;
  area?: string;
  ready?: boolean;
  created_at?: string;
  businesses?: number;
  quotes?: number;
  leading?: { business: string; total_usd: number };
  purchase?: { stage: string; summary: string; next: string };
}
export interface DealList {
  mode: Mode;
  deals: DealRow[];
  next: string;
}

export type ConversationView = Conversation;
export type IdentityView = Identity;

/** One wait_for_update event (packages/engine/src/contract.ts JobUpdate). */
export type JobUpdate = { type: string } & Record<string, unknown>;
export interface WaitResult {
  job_id: string;
  state: string;
  cursor: string;
  updates: JobUpdate[];
  timed_out: boolean;
  next?: string;
}
