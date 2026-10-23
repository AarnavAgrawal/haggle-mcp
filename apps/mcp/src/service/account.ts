// POST /internal/account/revoke (service token + x-haggle-workspace + x-haggle-actor): the web app is
// deleting a user's account. Open deals are cancelled first (cancel_deal's own path, so vendors are told
// and approvals withdrawn), then the workspace is revoked: its bearer token, connector URL and service
// access stop (every later call with this workspace is 401). Idempotent: a retried deletion whose revoke
// already landed answers 200 (already_revoked), so the web app can finish removing the user.
import { z } from "zod";
import { SERVICE_WORKSPACE_HEADER } from "../workspace.ts";
import { engineError, fail, serviceGuard, type ServiceApp } from "./http.ts";

/** Deals past these states are over; any other is cancelled before the workspace is revoked. */
const TERMINAL = new Set(["paid", "confirmed", "cancelled", "failed"]);
const RevokeBody = z.object({ confirm: z.literal(true) });

export function registerAccountRoutes(app: ServiceApp) {
  app.post("/internal/account/revoke", async (c) => {
    // Not `workspace: true`: that guard refuses a revoked workspace, and a retried deletion must succeed.
    const g = await serviceGuard(c);
    if (g instanceof Response) return g;
    const workspaceId = c.req.header(SERVICE_WORKSPACE_HEADER)?.trim() || null;
    const ws = workspaceId ? await g.rt.engine.workspaceById(workspaceId) : null;
    if (!workspaceId || !ws) return fail(c, 401, "UNAUTHORIZED", "Unknown workspace.", "Send x-haggle-workspace with the signed-in user's workspace id.");
    if (!g.actor) return fail(c, 400, "ACTOR_REQUIRED", "Revoking a workspace needs the user it acts for.", "Send x-haggle-actor with the signed-in user's id.");
    if (!RevokeBody.safeParse(await c.req.json().catch(() => null)).success) return fail(c, 400, "INVALID_INPUT", "Revoking a workspace must be confirmed.", "Send { confirm: true }.");
    if (ws.revoked_at) return c.json({ ok: true, workspace_id: workspaceId, revoked: true, already_revoked: true, cancelled: [], not_cancelled: [], next: "Delete the user's web data; this workspace is already revoked." });

    // Cancel what is still running, one deal at a time (cancel_deal's semantics: vendors told, approvals withdrawn).
    const scoped = g.rt.engine.forWorkspace(workspaceId);
    const cancelled: string[] = [];
    const notCancelled: { job_id: string; reason: string }[] = [];
    try {
      for (const d of await scoped.recentDeals(50)) {
        if (TERMINAL.has(d.state)) continue;
        try {
          const r = await scoped.cancel(d.job_id);
          if (r.state === "cancelled") cancelled.push(d.job_id);
          else notCancelled.push({ job_id: d.job_id, reason: r.note ?? (r.needs_approver ? "The vendor confirmed the booking: only the approver's CANCEL text cancels it." : `Deal is ${r.state}.`) });
        } catch (err) {
          notCancelled.push({ job_id: d.job_id, reason: (err as { message?: string }).message ?? "Cancel failed." });
        }
      }
      await g.rt.engine.revokeWorkspace(workspaceId);
    } catch (err) {
      return engineError(c, err, 500);
    }
    console.log(JSON.stringify({ level: "info", event: "workspace_revoked", workspace_id: workspaceId, actor: g.actor, cancelled: cancelled.length, not_cancelled: notCancelled.length }));
    return c.json({ ok: true, workspace_id: workspaceId, revoked: true, already_revoked: false, cancelled, not_cancelled: notCancelled, next: "Delete the user's web data; this workspace's credentials and service access are revoked." });
  });
}
