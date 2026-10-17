// get_job (DESIGN.md §8.3): status, vendor progress, the open approval, and
// optionally the last 10 events as one-line strings.
import { z } from "zod";
import type { MCPServer } from "mcp-use";
import { getCurrentQuotes, getJob, getJobEvents, getLatestApproval, getVendors, type JobEventRow } from "../db/queries.js";
import { advanceJob } from "../jobs/advanceJob.js";
import { nextStep, summarizeJob } from "../jobs/summary.js";
import { liveUrlFor } from "../live/links.js";
import { currentCaller, loadOwnedJob } from "./access.js";
import { money, ok, runTool } from "./format.js";

const inputSchema = z.object({
  job_id: z.string().uuid(),
  include_timeline: z.boolean().default(false),
});

const outputSchema = z.object({
  job_id: z.string(),
  status: z.string(),
  version: z.number().int(),
  round: z.number().int(),
  max_rounds: z.number().int(),
  collect_until: z.string().nullable(),
  counts: z.object({ vendors: z.number().int(), replied: z.number().int(), quotes: z.number().int() }),
  vendors: z.array(z.object({ name: z.string(), status: z.string() })),
  approval: z
    .object({ approval_id: z.string(), status: z.string(), vendor: z.string(), deposit: z.string().nullable(), expires_at: z.string() })
    .nullable(),
  summary: z.string(),
  live_url: z.string().nullable().describe("A page the human can open to watch this job live"),
  timeline: z.array(z.string()).optional(),
  next: z.string(),
});

/** PURE: "20:41:07 quote_parsed (round 0)" */
export function timelineLine(e: JobEventRow): string {
  const time = new Date(e.created_at).toISOString().slice(11, 19);
  const d = e.data as Record<string, unknown>;
  const detail =
    typeof d.from === "string" && typeof d.to === "string" && d.from !== d.to
      ? `${d.from} -> ${d.to}`
      : typeof d.round === "number"
        ? `round ${d.round}`
        : "";
  return `${time} ${e.type}${detail ? ` (${detail})` : ""}`;
}

export function registerGetJob(server: MCPServer) {
  return server.tool(
    {
      name: "get_job",
      description: "Get a job's status, vendor progress, and recent events. Use wait_for_job to wait for changes.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ job_id, include_timeline }, ctx) =>
      runTool("get_job", async () => {
        await loadOwnedJob(job_id, currentCaller(ctx));
        await advanceJob(job_id);
        const job = (await getJob(job_id))!;

        const [vendors, quotes, approval, events] = await Promise.all([
          getVendors(job_id),
          getCurrentQuotes(job_id),
          getLatestApproval(job_id),
          include_timeline ? getJobEvents(job_id, 10) : Promise.resolve([]),
        ]);
        const names = new Map(vendors.map((v) => [v.id, v.name]));

        return ok({
          job_id: job.id,
          status: job.status,
          version: job.version,
          round: job.round,
          max_rounds: job.max_rounds,
          collect_until: job.collect_until,
          counts: {
            vendors: vendors.length,
            replied: vendors.filter((v) => v.status === "replied" || v.status === "declined").length,
            quotes: quotes.length,
          },
          vendors: vendors.map((v) => ({ name: v.name, status: v.status })),
          approval: approval
            ? {
                approval_id: approval.id,
                status: approval.status,
                vendor: names.get(approval.vendor_id) ?? "unknown",
                deposit: money(approval.amount_cents),
                expires_at: approval.expires_at,
              }
            : null,
          summary: summarizeJob(job, vendors, quotes, approval),
          live_url: liveUrlFor(job.id),
          ...(include_timeline ? { timeline: events.reverse().map(timelineLine) } : {}),
          next: nextStep(job, approval),
        });
      }),
  );
}
