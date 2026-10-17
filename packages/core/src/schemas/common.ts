import { z } from "zod";

export const IsoDateTime = z.iso.datetime({ offset: true });
export const IsoDate = z.iso.date();

/** Prefixed, opaque identifiers ("job_…", "q_…"). The prefix makes misuse visible in logs. */
export function prefixedId<P extends string>(prefix: P) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_[A-Za-z0-9]{6,40}$`), `expected a ${prefix}_ identifier`)
    .brand<`${P}Id`>();
}

export const JobId = prefixedId("job");
export type JobId = z.infer<typeof JobId>;
export const SellerId = prefixedId("sel");
export type SellerId = z.infer<typeof SellerId>;
export const MessageId = prefixedId("msg");
export type MessageId = z.infer<typeof MessageId>;
export const QuoteId = prefixedId("q");
export type QuoteId = z.infer<typeof QuoteId>;
export const QuestionId = prefixedId("sq");
export type QuestionId = z.infer<typeof QuestionId>;
export const RoundId = prefixedId("rnd");
export type RoundId = z.infer<typeof RoundId>;
export const ApprovalId = prefixedId("apr");
export type ApprovalId = z.infer<typeof ApprovalId>;
export const ChallengeId = prefixedId("chl");
export type ChallengeId = z.infer<typeof ChallengeId>;
export const PaymentId = prefixedId("pay");
export type PaymentId = z.infer<typeof PaymentId>;
export const EventId = prefixedId("evt");
export type EventId = z.infer<typeof EventId>;

export const EmailAddress = z
  .email()
  .transform((s) => s.trim().toLowerCase());
export type EmailAddress = z.infer<typeof EmailAddress>;

/**
 * Where a fact came from. Every important quote field carries one so a human
 * (or judge) can click through to the exact evidence.
 */
export const ProvenanceSource = z.enum([
  "quote_json", // structured quote.json part from the seller
  "email_text", // plain-text body
  "email_html", // HTML body
  "pdf_attachment",
  "buyer_input", // the buyer agent's deal() request
  "derived", // computed by Haggle from other fields (e.g. per-head × headcount)
  "system",
]);
export type ProvenanceSource = z.infer<typeof ProvenanceSource>;

export const Provenance = z.object({
  source: ProvenanceSource,
  message_id: MessageId.optional(),
  attachment_name: z.string().optional(),
  page: z.number().int().positive().optional(),
  /** Short verbatim excerpt supporting the value. Never paraphrased. */
  excerpt: z.string().max(500).optional(),
  /** Extraction confidence (0..1) — how sure Haggle is it read the text right, NOT whether the seller is honest. */
  extraction_confidence: z.number().min(0).max(1),
  extractor: z.enum(["deterministic", "llm", "buyer"]),
});
export type Provenance = z.infer<typeof Provenance>;

/**
 * A field whose value may be stated, derived, missing or ambiguous.
 * Missing values are explicit — never coerced to zero.
 */
export function evidenced<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("status", [
    z.object({ status: z.literal("stated"), value, provenance: Provenance }),
    z.object({ status: z.literal("derived"), value, provenance: Provenance, derivation: z.string() }),
    z.object({ status: z.literal("missing") }),
    z.object({
      status: z.literal("ambiguous"),
      candidates: z.array(value).max(10),
      provenance: Provenance,
      note: z.string(),
    }),
  ]);
}

export const SellerKind = z.enum(["agent", "human", "unknown"]);
export type SellerKind = z.infer<typeof SellerKind>;
