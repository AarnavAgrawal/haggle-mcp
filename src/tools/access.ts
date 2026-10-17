// Ownership checks shared by every tool that takes a job_id.
import { getConfig } from "../config.js";
import { callerFromContext, canAccess, type Caller } from "../caller.js";
import { getJob, type JobRow } from "../db/queries.js";
import { toolError } from "./errors.js";

/** The verified caller for this tool call (the operator in token mode). */
export function currentCaller(ctx: unknown): Caller {
  return callerFromContext(ctx, getConfig().AUTH_MODE);
}

/**
 * Load a job the caller owns. Someone else's job gets the same answer as a
 * job that doesn't exist, so job ids can't be probed.
 */
export async function loadOwnedJob(jobId: string, caller: Caller): Promise<JobRow> {
  const job = await getJob(jobId);
  if (!job || !canAccess(job, caller)) {
    throw toolError("JOB_NOT_FOUND", "No job with that id.", "Check the job_id returned by create_quote_request.");
  }
  return job;
}
