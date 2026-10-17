// cancel_job (DESIGN.md §8.3): cancel a job and send a short note to vendors
// who already replied. Any pending approval is expired so it can't be used.
import { z } from "zod";
import type { MCPServer } from "mcp-use";
import { getJob } from "../db/queries.js";
import { fireEvent } from "../jobs/advanceJob.js";
import { TERMINAL } from "../jobs/stateMachine.js";
import { currentCaller, loadOwnedJob } from "./access.js";
import { toolError } from "./errors.js";
import { ok, runTool } from "./format.js";

export function registerCancelJob(server: MCPServer) {
  return server.tool(
    {
      name: "cancel_job",
      description: "Cancel a job. Sends a short note to vendors who already replied.",
      inputSchema: z.object({ job_id: z.string().uuid() }),
      outputSchema: z.object({ job_id: z.string(), status: z.string(), next: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ job_id }, ctx) =>
      runTool("cancel_job", async () => {
        const job = await loadOwnedJob(job_id, currentCaller(ctx));
        if (job.status === "cancelled") return ok({ job_id, status: "cancelled", next: "The job is already cancelled." });
        if (TERMINAL.has(job.status)) {
          throw toolError("JOB_ALREADY_FINISHED", `The job is already ${job.status}.`, "Nothing to cancel. Call get_job to see the final state.");
        }

        const r = await fireEvent(job_id, { type: "cancelled" }, { by: "agent" });
        if (r.status !== "applied") {
          const now = await getJob(job_id);
          if (now?.status === "cancelled") return ok({ job_id, status: "cancelled", next: "The job is already cancelled." });
          throw toolError("JOB_ALREADY_FINISHED", `The job could not be cancelled (status ${now?.status}).`, "Call get_job to see the current state.");
        }
        return ok({ job_id, status: "cancelled", next: "The job is cancelled. Nothing else to do." });
      }),
  );
}
