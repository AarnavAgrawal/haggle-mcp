import { z } from "zod";
import { IsoDate } from "./common.ts";

/**
 * Requirements are structured, vertical-agnostic constraints. Catering is the
 * first vertical ("12 vegetarian meals"), but the same kinds express printing
 * ("500 cards, 100 on recycled stock") or merchandise ("delivered by Fri").
 */
const base = {
  id: z.string().regex(/^req_[a-z0-9_]{1,40}$/),
  /** Human-readable form shown to sellers and on the deal board. */
  label: z.string().min(1).max(200),
  /** Mandatory requirements disqualify a quote when unmet; preferences only affect ranking. */
  mandatory: z.boolean().default(true),
};

export const Requirement = z.discriminatedUnion("kind", [
  z.object({
    ...base,
    kind: z.literal("quantity"),
    /** What is being counted, e.g. "meals", "business cards", "t-shirts". */
    unit: z.string().min(1).max(60),
    min: z.number().int().positive(),
    max: z.number().int().positive().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("tagged_quantity"),
    /** A subset attribute, e.g. "vegetarian", "gluten-free", "size XL". */
    tag: z.string().min(1).max(60),
    unit: z.string().min(1).max(60),
    min: z.number().int().positive(),
  }),
  z.object({
    ...base,
    kind: z.literal("delivery"),
    required: z.boolean(),
    /** Free-text delivery location; precise address is shared only once a deal is confirmed. */
    location: z.string().max(200).optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("fulfillment_date"),
    date: IsoDate,
    /** Optional local time window like "11:30-12:30". */
    window: z.string().max(40).optional(),
    timezone: z.string().max(64).optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("location"),
    area: z.string().min(1).max(200),
  }),
  z.object({
    ...base,
    kind: z.literal("custom"),
    /** Unstructured requirement; evaluated conservatively (unknown → needs clarification). */
    text: z.string().min(1).max(500),
  }),
]);
export type Requirement = z.infer<typeof Requirement>;
export type RequirementKind = Requirement["kind"];

export const JobRequirements = z
  .array(Requirement)
  .max(30)
  .refine((reqs) => new Set(reqs.map((r) => r.id)).size === reqs.length, "requirement ids must be unique");
export type JobRequirements = z.infer<typeof JobRequirements>;

/** Outcome of checking one requirement against one quote. */
export const RequirementCheck = z.object({
  requirement_id: z.string(),
  status: z.enum(["met", "unmet", "unknown"]),
  /** Short reason, e.g. "6 vegetarian meals quoted, 12 required". */
  detail: z.string().max(200),
});
export type RequirementCheck = z.infer<typeof RequirementCheck>;
