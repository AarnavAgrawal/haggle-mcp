// Service routes for workspaces (service token).
//   POST /internal/workspaces                  the web app creates the workspace for a newly signed-up
//                                              user, once per owner (idempotent), with its approver and cap
//   GET  /internal/workspaces/settings         the owner's editable settings (approver masked) and any
//                                              approver change waiting for verification
//   POST /internal/workspaces/settings         { name?, default_area?, timezone?, sender_name?,
//                                              approver_email?, approver_phone?, default_deal_limit_usd?,
//                                              confirm_url? } the owner changes settings
//   POST /internal/workspaces/settings/confirm { kind, code } or { token } confirms a new approver
//   POST /internal/workspaces/settings/cancel  { kind } withdraws a pending approver change
// The settings routes need x-haggle-workspace and x-haggle-actor, and the actor must be the workspace's
// owner (the account its id was derived from): a member or another account is refused. A new approver
// phone or email isn't applied: Haggle texts a code (or emails a confirm link) and keeps the current
// approver until it is confirmed. Limits up to the server ceiling (HAGGLE_SPENDING_CAP_CEILING_CENTS).
// The MCP tools and the native settings panel stay the agent's (no approver change, no raise).
import { z } from "zod";
import { actorOwnsWorkspace, planServiceWorkspace } from "../workspace.ts";
import { engineError, fail, serviceGuard, type ServiceApp, type ServiceContext } from "./http.ts";

const ProvisionBody = z.object({
  owner_ref: z.string().min(1).max(200), name: z.string().max(120).optional(),
  approver_phone: z.string().optional(), approver_email: z.string().email().optional(),
  cap_usd: z.number().positive().optional(), timezone: z.string().max(64).optional(), area: z.string().max(120).optional(),
});

const phone = z.string().trim().max(32).transform((s) => s.replace(/[\s().-]/g, "")).pipe(z.string().regex(/^\+[1-9]\d{6,14}$/, "an E.164 phone number, e.g. +14155550123"));
/** "" clears a field (null); absent leaves it. */
const clearable = <T extends z.ZodTypeAny>(t: T) => z.union([z.literal("").transform(() => null), z.null(), t]);
export const SettingsBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  default_area: clearable(z.string().trim().min(2).max(200)).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  sender_name: clearable(z.string().trim().min(1).max(80)).optional(),
  approver_email: clearable(z.string().trim().toLowerCase().max(254).email()).optional(),
  approver_phone: clearable(phone).optional(),
  default_deal_limit_usd: z.number().positive().max(1_000_000).optional(),
  /** The web app's settings page; the confirm email links to it (?confirm=<token>). */
  confirm_url: z.string().url().max(300).refine((u) => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u), "an https URL").optional(),
}).strict().refine((b) => Object.keys(b).some((k) => k !== "confirm_url"), "nothing to change");
const ConfirmBody = z.union([
  z.object({ kind: z.enum(["phone", "email"]), code: z.string().trim().regex(/^\d{3}[\s-]?\d{3}$/, "the 6-digit code") }).strict(),
  z.object({ token: z.string().trim().min(20).max(100).regex(/^[A-Za-z0-9_-]+$/) }).strict(),
]);
const CancelBody = z.object({ kind: z.enum(["phone", "email"]) }).strict();
const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");

/** Wrong stage or wrong code: 409 / 422 so the web app can show it next to the field. */
const STATUS: Record<string, number> = { no_pending_change: 409, verification_expired: 410, wrong_code: 422, too_many_attempts: 429, settings_store_outdated: 503, imessage_off: 409, verification_not_sent: 502 };

/** An engine refusal with its status; a database without migration 129 (42P01 / 42703) as 503 with the fix. */
function refusal(c: ServiceContext, err: unknown) {
  const code = (err as { code?: string }).code ?? "";
  if (code === "42P01" || code === "42703") return fail(c, 503, "settings_store_outdated", "This server's database can't store owner settings changes yet.", "The operator must apply supabase/migrations/129_engine_settings_audit.sql.");
  return engineError(c, err, STATUS[code] ?? 400);
}

/** The service guard plus the owner check every settings route runs. */
async function ownerGuard(c: ServiceContext) {
  const g = await serviceGuard(c, { workspace: true });
  if (g instanceof Response) return g;
  if (!g.actor) return fail(c, 400, "ACTOR_REQUIRED", "Changing settings records who changed them.", "Send x-haggle-actor with the signed-in user.");
  if (!actorOwnsWorkspace(g.actor, g.workspaceId!)) return fail(c, 403, "NOT_OWNER", "Only the workspace's owner can change its settings.", "Sign in as the account that created this workspace.");
  return { engine: g.rt.engine, mode: g.rt.mode, workspaceId: g.workspaceId!, actor: g.actor };
}

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

  app.get("/internal/workspaces/settings", async (c) => {
    const g = await serviceGuard(c, { workspace: true });
    if (g instanceof Response) return g;
    try {
      const settings = await g.rt.engine.workspaceSettings(g.workspaceId!);
      return c.json({ ok: true, mode: g.rt.mode, settings, next: settings.pending.length ? "Enter the code Haggle sent to the new approver (POST /internal/workspaces/settings/confirm)." : "The owner may change these (POST /internal/workspaces/settings)." });
    } catch (err) {
      return refusal(c, err);
    }
  });

  app.post("/internal/workspaces/settings", async (c) => {
    const g = await ownerGuard(c);
    if (g instanceof Response) return g;
    const parsed = SettingsBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "INVALID_INPUT", issues(parsed.error), "Send any of name, default_area, timezone, sender_name, approver_email, approver_phone (E.164), default_deal_limit_usd; \"\" clears an optional one.");
    const { default_deal_limit_usd, confirm_url, ...rest } = parsed.data;
    try {
      const r = await g.engine.ownerUpdateSettings(g.workspaceId, g.actor, {
        ...rest, ...(default_deal_limit_usd !== undefined ? { spending_cap_cents: Math.round(default_deal_limit_usd * 100) } : {}),
      }, { confirmUrl: confirm_url ?? null });
      const pending = r.changed.filter((f) => f.endsWith("_pending"));
      return c.json({
        ok: true, mode: g.mode, settings: r.settings, changed: r.changed.filter((f) => !f.endsWith("_pending")),
        pending_verification: pending.map((f) => (f.includes("phone") ? "phone" : "email")),
        // DEMO only (mock mode): nothing is sent, so the code is shown to the person instead.
        ...(r.demo_codes ? { demo_codes: r.demo_codes, simulated: true } : {}),
        next: pending.length ? "Enter the code Haggle sent to the new approver; the current approver stays until then." : "Saved.",
      });
    } catch (err) {
      return refusal(c, err);
    }
  });

  app.post("/internal/workspaces/settings/confirm", async (c) => {
    const g = await ownerGuard(c);
    if (g instanceof Response) return g;
    const parsed = ConfirmBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "INVALID_INPUT", issues(parsed.error), "Send { kind: \"phone\" | \"email\", code: \"123456\" } or { token } from the confirm link.");
    try {
      const r = await g.engine.confirmApproverChange(g.workspaceId, g.actor, parsed.data);
      return c.json({ ok: true, mode: g.mode, confirmed: r.confirmed, settings: r.settings, next: `The new approver ${r.confirmed} is in effect.` });
    } catch (err) {
      return refusal(c, err);
    }
  });

  app.post("/internal/workspaces/settings/cancel", async (c) => {
    const g = await ownerGuard(c);
    if (g instanceof Response) return g;
    const parsed = CancelBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "INVALID_INPUT", issues(parsed.error), "Send { kind: \"phone\" | \"email\" }.");
    try {
      const r = await g.engine.cancelApproverChange(g.workspaceId, g.actor, parsed.data.kind);
      return c.json({ ok: true, mode: g.mode, cancelled: r.cancelled, settings: r.settings, next: "The current approver stays." });
    } catch (err) {
      return refusal(c, err);
    }
  });
}
