// POST /internal/workspaces (service token): the web app creates the workspace for a newly signed-up
// user, once per owner (idempotent), with its approver and cap. The web app then calls the MCP endpoint
// with the service token and x-haggle-workspace.
import { z } from "zod";
import { planServiceWorkspace } from "../workspace.ts";
import { engineError, fail, serviceGuard, type ServiceApp } from "./http.ts";

const ProvisionBody = z.object({
  owner_ref: z.string().min(1).max(200), name: z.string().max(120).optional(),
  approver_phone: z.string().optional(), approver_email: z.string().email().optional(),
  cap_usd: z.number().positive().optional(), timezone: z.string().max(64).optional(), area: z.string().max(120).optional(),
});

export function registerWorkspaceRoutes(app: ServiceApp) {
  app.post("/internal/workspaces", async (c) => {
    const g = await serviceGuard(c);
    if (g instanceof Response) return g;
    const body = ProvisionBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(c, 400, "INVALID_INPUT", body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), "Pass owner_ref and optional name, approver_phone (E.164), approver_email, cap_usd, timezone, area.");
    const b = body.data;
    try {
      const plan = planServiceWorkspace({ ownerRef: b.owner_ref, name: b.name ?? "My workspace", approverPhone: b.approver_phone, approverEmail: b.approver_email, capUsd: b.cap_usd, timezone: b.timezone, area: b.area });
      const r = await g.rt.engine.provisionWorkspace(plan);
      return c.json({ ok: true, workspace_id: r.workspace.id, created: r.created }, r.created ? 201 : 200);
    } catch (err) {
      return engineError(c, err);
    }
  });
}
