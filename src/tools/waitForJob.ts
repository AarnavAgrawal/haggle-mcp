// wait_for_job (DESIGN.md §8.3): long-poll the database until the job changes
// or a condition is met, advancing the job on every loop. The agent's session
// never has to sit idle while restaurants take minutes to reply.
import { z } from "zod";
import type { MCPServer } from "mcp-use";
import { getCurrentQuotes, getJob, getLatestApproval, getVendors, type JobRow } from "../db/queries.js";
import { advanceJob } from "../jobs/advanceJob.js";
import { TERMINAL } from "../jobs/stateMachine.js";
import { nextStep, summarizeJob } from "../jobs/summary.js";
import { currentCaller, loadOwnedJob } from "./access.js";
import { toolError } from "./errors.js";
import { ok, runTool } from "./format.js";

const POLL_MS = 2000;

const inputSchema = z.object({
  job_id: z.string().uuid(),
  until: z
    .enum(["any_change", "ready", "approval_decided", "done"])
    .default("any_change")
    .describe("any_change: return on any update. ready: quotes are final. approval_decided: the human answered. done: paid, expired, or cancelled."),
  since_version: z.number().int().optional().describe("Return only if the job version is newer than this"),
  timeout_seconds: z.number().int().min(1).max(50).default(30),
});

const outputSchema = z.object({
  job_id: z.string(),
  status: z.string(),
  version: z.number().int(),
  changed: z.boolean(),
  summary: z.string(),
  next: z.string(),
});

type Until = z.infer<typeof inputSchema>["until"];

/** PURE: is the wait condition met? */
export function conditionMet(until: Until, job: Pick<JobRow, "status" | "version">, baseline: number): boolean {
  switch (until) {
    case "any_change":
      return job.version > baseline;
    case "ready":
      return job.status !== "collecting" && job.status !== "negotiating";
    case "approval_decided":
      return job.status !== "awaiting_approval";
    case "done":
      return TERMINAL.has(job.status);
  }
}

export function registerWaitForJob(server: MCPServer) {
  return server.tool(
    {
      name: "wait_for_job",
      description: "Wait for a job to change. Returns as soon as something happens or after the timeout. Use this instead of polling get_job.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ job_id, until, since_version, timeout_seconds }, ctx) =>
      runTool("wait_for_job", async () => {
        const deadline = Date.now() + timeout_seconds * 1000;
        const signal = (ctx as { signal?: AbortSignal } | undefined)?.signal;

        let job = await loadOwnedJob(job_id, currentCaller(ctx));
        const baseline = since_version ?? job.version;

        let met = false;
        while (true) {
          await advanceJob(job_id);
          job = (await getJob(job_id))!;
          met = conditionMet(until, job, baseline);
          // A terminal job never changes again; don't make the agent wait it out.
          if (met || TERMINAL.has(job.status) || Date.now() + POLL_MS > deadline || signal?.aborted) break;
          await new Promise((r) => setTimeout(r, POLL_MS));
        }

        const [vendors, quotes, approval] = await Promise.all([
          getVendors(job_id),
          getCurrentQuotes(job_id),
          getLatestApproval(job_id),
        ]);
        return ok({
          job_id,
          status: job.status,
          version: job.version,
          changed: met,
          summary: summarizeJob(job, vendors, quotes, approval),
          next: met || TERMINAL.has(job.status) ? nextStep(job, approval) : `Nothing yet. Call wait_for_job again with until='${until}'.`,
        });
      }),
  );
}
