// create_quote_request (DESIGN.md §8.3): save the job and vendors, email every
// vendor, and return a job_id right away. Replies arrive later by webhook.
import { randomInt } from "node:crypto";
import { z } from "zod";
import type { MCPServer } from "mcp-use";
import { getConfig } from "../config.js";
import { DbError, UNIQUE_VIOLATION } from "../db/client.js";
import {
  countJobsByOwnerSince,
  findJobByClientRequestId,
  getVendors,
  insertJob,
  insertJobEvent,
  insertMessage,
  insertVendors,
  updateJobVersioned,
  updateVendor,
  type EventDetails,
  type JobRow,
  type VendorRow,
} from "../db/queries.js";
import { emailChannel } from "../channels/email.js";
import { buildOutreach } from "../channels/outreach.js";
import { canAccess, scopedClientRequestId, type Caller } from "../caller.js";
import { liveUrlFor } from "../live/links.js";
import { notAllowed, parseDemoVendors } from "../vendors/demoVendors.js";
import { currentCaller } from "./access.js";
import { toolError } from "./errors.js";
import { ok, runTool, toCents } from "./format.js";

export const inputSchema = z.object({
  event: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD"),
    time: z.string().regex(/^\d{2}:\d{2}$/).describe("HH:MM, 24-hour, local to the event"),
    headcount: z.number().int().min(1).max(500),
    location: z.string().max(200).describe("Delivery address or venue"),
    dietary: z
      .array(
        z.object({
          need: z.string().max(50).describe("e.g. vegetarian, vegan, gluten-free"),
          count: z.number().int().min(1),
        }),
      )
      .default([]),
    cuisine: z.string().max(100).optional(),
    notes: z.string().max(500).optional(),
  }),
  budget_per_head_usd: z.number().positive().optional(),
  vendors: z
    .array(z.object({ name: z.string().max(100), email: z.string().email() }))
    .min(1)
    .max(5),
  max_rounds: z.number().int().min(0).max(2).optional().describe("Negotiation rounds after the first quotes (default 1)"),
  client_request_id: z
    .string()
    .max(64)
    .optional()
    .describe("Optional. Reusing the same id returns the same job instead of emailing vendors again."),
});

const outputSchema = z.object({
  job_id: z.string(),
  status: z.string(),
  vendors_contacted: z.number().int(),
  vendors_failed: z.array(z.string()),
  collect_until: z.string().nullable(),
  live_url: z.string().nullable().describe("A page the human can open to watch this job live"),
  next: z.string(),
});

const NEXT = "Call wait_for_job with this job_id and until='ready'.";
const CONTACTED = new Set(["contacted", "replied", "declined", "no_reply"]);

// No 0/O/1/I so codes read cleanly in a subject line.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newShortCode(): string {
  return Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
}

function summarize(job: JobRow, vendors: VendorRow[]) {
  return {
    job_id: job.id,
    status: job.status,
    vendors_contacted: vendors.filter((v) => CONTACTED.has(v.status)).length,
    vendors_failed: vendors.filter((v) => v.status === "send_failed").map((v) => v.name),
    collect_until: job.collect_until,
    live_url: liveUrlFor(job.id),
    next: NEXT,
  };
}

/** Public users may only contact the demo restaurants (DESIGN.md §16). */
function checkVendorsAllowed(emails: string[]) {
  const cfg = getConfig();
  const allowed = parseDemoVendors(cfg.DEMO_VENDORS);
  if (cfg.AUTH_MODE !== "oauth" && allowed.length === 0) return; // single operator, no list configured
  if (allowed.length === 0) {
    throw toolError("CONFIG_MISSING", "No demo restaurants are configured.", "Ask the server operator to set DEMO_VENDORS.", { details: { missing: ["DEMO_VENDORS"] } });
  }
  const rejected = notAllowed(emails, allowed);
  if (rejected.length > 0) {
    throw toolError(
      "INVALID_INPUT",
      "This server only contacts its simulated demo restaurants, never real businesses.",
      "Call list_demo_vendors and use vendors from that list.",
      { details: { not_allowed: rejected } },
    );
  }
}

/** Per-user cap on new jobs in a rolling 24 hours (each job costs email and model calls). */
async function checkDailyLimit(caller: Caller) {
  if (!caller.userId) return;
  const limit = getConfig().JOBS_PER_USER_PER_DAY;
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  if ((await countJobsByOwnerSince(caller.userId, since)) >= limit) {
    throw toolError("RATE_LIMITED", `You can start up to ${limit} quote requests per day.`, "Reuse an existing job, or try again tomorrow.");
  }
}

/** Insert the job, retrying on a short-code collision. Returns [job, isNew]. */
async function createJob(fields: Omit<Parameters<typeof insertJob>[0], "short_code">, caller: Caller): Promise<[JobRow, boolean]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return [await insertJob({ ...fields, short_code: newShortCode() }), true];
    } catch (err) {
      if (!(err instanceof DbError) || err.code !== UNIQUE_VIOLATION) throw err;
      // A concurrent call with the same client_request_id won the race.
      if (fields.client_request_id) {
        const existing = await findJobByClientRequestId(fields.client_request_id);
        if (existing && canAccess(existing, caller)) return [existing, false];
      }
      // Otherwise the short code collided; try another.
    }
  }
  throw new Error("could not allocate a unique short code");
}

export function registerCreateQuoteRequest(server: MCPServer) {
  return server.tool(
    {
      name: "create_quote_request",
      description:
        "Start a catering quote request. Emails each vendor and returns a job_id right away. Replies arrive over minutes; use wait_for_job to follow progress. On the public demo, vendors must come from list_demo_vendors.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input, ctx) =>
      runTool("create_quote_request", async () => {
        const cfg = getConfig();
        const caller = currentCaller(ctx);
        const clientRequestId = input.client_request_id ? scopedClientRequestId(caller, input.client_request_id) : null;

        // Idempotent replay: same client_request_id -> same job, no new emails.
        if (clientRequestId) {
          const existing = await findJobByClientRequestId(clientRequestId);
          if (existing && canAccess(existing, caller)) return ok(summarize(existing, await getVendors(existing.id)));
        }

        const emails = input.vendors.map((v) => v.email.toLowerCase());
        if (new Set(emails).size !== emails.length) {
          throw toolError("INVALID_INPUT", "Each vendor must have a different email address.", "Remove the duplicate vendor and call create_quote_request again.");
        }
        checkVendorsAllowed(emails);
        await checkDailyLimit(caller);

        const event: EventDetails = {
          date: input.event.date,
          time: input.event.time,
          headcount: input.event.headcount,
          location: input.event.location,
          dietary: input.event.dietary,
          cuisine: input.event.cuisine,
          notes: input.event.notes,
        };
        const budgetCents = input.budget_per_head_usd !== undefined ? toCents(input.budget_per_head_usd) : null;

        const [job, isNew] = await createJob({
          status: "collecting",
          event,
          budget_per_head_cents: budgetCents,
          max_rounds: input.max_rounds ?? cfg.MAX_ROUNDS_DEFAULT,
          collect_until: new Date(Date.now() + cfg.collectionWindowSeconds * 1000).toISOString(),
          client_request_id: clientRequestId,
          // Only written in public mode, so token mode keeps working on a
          // database that hasn't had the owner_id migration yet.
          ...(caller.userId ? { owner_id: caller.userId } : {}),
        }, caller);
        if (!isNew) return ok(summarize(job, await getVendors(job.id)));

        const vendors = await insertVendors(job.id, input.vendors);

        // Email every vendor in parallel. The idempotency key is per vendor, so
        // a retry of this whole call can never email the same vendor twice.
        const results = await Promise.allSettled(
          vendors.map(async (v) => {
            const { subject, bodyText } = buildOutreach({
              shortCode: job.short_code,
              vendorName: v.name,
              event,
              budgetPerHeadCents: budgetCents,
            });
            const sent = await emailChannel.send({
              jobId: job.id,
              vendorId: v.id,
              to: v.email!,
              subject,
              bodyText,
              idempotencyKey: `outreach:${v.id}`,
            });
            await updateVendor(v.id, {
              status: "contacted",
              outbound_email_id: sent.providerId,
              outbound_message_id: sent.messageId ?? null,
            });
            await insertMessage({
              job_id: job.id,
              vendor_id: v.id,
              direction: "out",
              kind: "outreach",
              provider_email_id: sent.providerId,
              rfc_message_id: sent.messageId ?? null,
              thread_id: null,
              from_address: cfg.PRIMITIVE_FROM_ADDRESS,
              subject,
              body_text: bodyText,
              attachments: [],
              sender_authenticated: null,
              parse_status: "none",
            });
          }),
        );

        const failed: string[] = [];
        for (const [i, r] of results.entries()) {
          if (r.status === "rejected") {
            const v = vendors[i]!;
            failed.push(v.name);
            console.error(`[create_quote_request] send failed for vendor ${v.id}:`, r.reason instanceof Error ? r.reason.message : r.reason);
            await updateVendor(v.id, { status: "send_failed" });
          }
        }

        await insertJobEvent(job.id, "created", { vendors: vendors.length, send_failures: failed.length });
        const updated = await updateJobVersioned(job.id);

        if (failed.length === vendors.length) {
          throw toolError(
            "SEND_FAILED",
            "Could not email any of the vendors.",
            "Check the vendor email addresses, then call create_quote_request again with a new client_request_id.",
            { retryable: true, details: { job_id: job.id, vendors_failed: failed } },
          );
        }
        return ok(summarize(updated, await getVendors(job.id)));
      }),
  );
}
