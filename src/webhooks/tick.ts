// POST /internal/tick (DESIGN.md §7.4): advance every open job. A backup for
// "advance on touch": call it every minute from any cron (Supabase pg_cron +
// pg_net, cron-job.org, a GitHub Action) with the shared secret.
import type { Context } from "hono";
import { secretMatches } from "../auth.js";
import { listOpenJobIds } from "../db/queries.js";
import { advanceJob } from "../jobs/advanceJob.js";

export async function handleTick(c: Context): Promise<Response> {
  // No secret configured: the endpoint stays disabled.
  if (!secretMatches(c.req.header("authorization"), process.env.INTERNAL_TICK_SECRET)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const ids = await listOpenJobIds();
  let failed = 0;
  for (const id of ids) {
    try {
      await advanceJob(id);
    } catch (err) {
      failed++;
      console.error(`[tick] job ${id}:`, err instanceof Error ? err.message : err);
    }
  }
  return c.json({ ok: true, jobs: ids.length, failed });
}
