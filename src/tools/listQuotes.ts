// list_quotes (DESIGN.md §8.3): the current quote from each vendor in one
// comparable format, with the best one flagged.
import { z } from "zod";
import type { MCPServer } from "mcp-use";
import { getCurrentQuotes, getJob, getVendors, type JobRow, type QuoteRow, type VendorRow } from "../db/queries.js";
import { advanceJob } from "../jobs/advanceJob.js";
import { dietaryOk, pickBest } from "./best.js";
import { currentCaller, loadOwnedJob } from "./access.js";
import { toolError } from "./errors.js";
import { money, ok, runTool } from "./format.js";

const inputSchema = z.object({
  job_id: z.string().uuid(),
  sort_by: z.enum(["total", "per_head"]).default("total"),
  include_menu: z.boolean().default(false),
});

const quoteOut = z.object({
  quote_id: z.string(),
  vendor: z.string(),
  available: z.boolean(),
  per_head: z.string().nullable(),
  total: z.string().nullable(),
  deposit: z.string().nullable(),
  delivery: z.string().nullable(),
  dietary_ok: z.boolean(),
  valid_until: z.string().nullable(),
  round: z.number().int(),
  missing_fields: z.array(z.string()),
  menu: z.array(z.string()).optional(),
});

const outputSchema = z.object({
  job_id: z.string(),
  status: z.string(),
  best_quote_id: z.string().nullable(),
  quotes: z.array(quoteOut),
  no_quote: z.array(z.object({ vendor: z.string(), reason: z.string() })),
  next: z.string(),
});

function noQuoteReason(v: VendorRow, job: JobRow): string {
  if (v.status === "send_failed" || v.status === "bounced") return v.status;
  const pastDeadline = job.collect_until !== null && Date.now() > Date.parse(job.collect_until);
  return pastDeadline ? "no_reply" : "waiting";
}

export function registerListQuotes(server: MCPServer) {
  return server.tool(
    {
      name: "list_quotes",
      description: "List the current quote from each vendor in one comparable format, with the best one flagged.",
      inputSchema,
      outputSchema,
      // MCP App view: hosts that render Apps show a comparison table.
      view: { name: "quote-board", description: "Side-by-side catering quotes with the best one highlighted", prefersBorder: true },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ job_id, sort_by, include_menu }, ctx) =>
      runTool("list_quotes", async () => {
        await loadOwnedJob(job_id, currentCaller(ctx));
        // Advance on touch: parse any replies that arrived but weren't parsed yet.
        await advanceJob(job_id);

        const job = (await getJob(job_id))!;

        const [vendors, quotes] = await Promise.all([getVendors(job_id), getCurrentQuotes(job_id)]);
        const vendorName = new Map(vendors.map((v) => [v.id, v.name]));
        const best = pickBest(job, quotes);

        const sortKey = (q: QuoteRow) =>
          (sort_by === "per_head" ? q.price_per_head_cents : q.total_cents) ?? Number.MAX_SAFE_INTEGER;
        const sorted = [...quotes].sort((a, b) => Number(b.available) - Number(a.available) || sortKey(a) - sortKey(b));

        const quoted = new Set(quotes.map((q) => q.vendor_id));
        const noQuote = vendors
          .filter((v) => !quoted.has(v.id))
          .map((v) => ({ vendor: v.name, reason: noQuoteReason(v, job) }));

        const next = best
          ? "Pick a quote and call request_approval with its quote_id."
          : quotes.length === 0
            ? "No quotes yet. Call wait_for_job with until='ready'."
            : "No quote is complete and covers every dietary need yet. Call wait_for_job, or pick one anyway with request_approval.";

        return ok({
          job_id: job.id,
          status: job.status,
          best_quote_id: best?.id ?? null,
          quotes: sorted.map((q) => ({
            quote_id: q.id,
            vendor: vendorName.get(q.vendor_id) ?? "unknown",
            available: q.available,
            per_head: money(q.price_per_head_cents),
            total: money(q.total_cents),
            deposit: money(q.deposit_cents),
            delivery: money(q.delivery_fee_cents),
            dietary_ok: dietaryOk(job, q),
            valid_until: q.valid_until,
            round: q.round,
            missing_fields: q.missing_fields,
            ...(include_menu ? { menu: q.menu_items } : {}),
          })),
          no_quote: noQuote,
          next,
        });
      }),
  );
}
