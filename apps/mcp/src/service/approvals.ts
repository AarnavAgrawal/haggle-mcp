// Service routes for approvals and the purchase lifecycle decided by the signed-in account owner in the
// Haggle web app. The web backend is a first-party host that reaches these only with the service token
// and names the user it acts for (x-haggle-actor); its clicks are the human's own (approval channel
// "web", recorded as web:<actor>). No MCP tool reaches them: agent-facing rules are unchanged.
//   POST /internal/approvals/request   { job_id, quote_id, action?: "pay" | "confirm" }  open or reuse (no code)
//   POST /internal/approvals/decide    { approval_id, decision: "approve" | "decline" }  actor required
//   POST /internal/purchases/paid      { job_id }  the human paid the vendor directly (as PAID <code>)
//   POST /internal/purchases/booked    { job_id }  the human accepts the booking (as BOOKED <code>)
//   POST /internal/purchases/cancel    { job_id }  cancel, a vendor-confirmed booking too (as CANCEL <code>)
//   POST /internal/callbacks/authorize { job_id, business_id }  one callback (as CALL <code>), consent required
// Every route acts only inside the x-haggle-workspace (another workspace's ids read as not found).
// HAGGLE_WEB_APPROVALS=false turns them off (default on whenever HAGGLE_SERVICE_TOKEN is set). Responses
// are built field by field: an approval's code never leaves the server.
import { z } from "zod";
import type { HaggleEngine } from "@haggle/engine";
import { engineError, fail, serviceGuard, type ServiceApp, type ServiceContext } from "./http.ts";

/** HAGGLE_WEB_APPROVALS: on unless set to false/0/off/no. */
export function webApprovalsOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(false|0|off|no)$/i.test(env.HAGGLE_WEB_APPROVALS?.trim() ?? "");
}

/** The Haggle web app can act on this server: a service token (32+ chars) and web approvals not turned off. */
export function webAppOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.HAGGLE_SERVICE_TOKEN?.trim().length ?? 0) >= 32 && webApprovalsOn(env);
}

const id = z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_.:-]+$/, "unexpected characters");
const Bodies = {
  request: z.object({ job_id: id, quote_id: id, action: z.enum(["pay", "confirm"]).optional() }),
  decide: z.object({ approval_id: id, decision: z.enum(["approve", "decline"]) }),
  job: z.object({ job_id: id }),
  callback: z.object({ job_id: id, business_id: id }),
};

const NOT_FOUND = new Set(["job_not_found", "approval_not_found", "quote_not_found"]);
const CONFLICT = /^(approval_|not_approvable|not_payable|paid_before_booking|no_handoff|no_booking|nothing_to_pay|handoff_refused|cannot_cancel|quote_reconfirming|quote_stale|callback_|no_rounds_left)/;
/** An engine refusal with a status the web app can act on: 404 not found, 403 off, 409 wrong stage, 400 otherwise. */
function refusal(c: ServiceContext, err: unknown) {
  const code = (err as { code?: string }).code ?? "";
  if (!code) return fail(c, 500, "INTERNAL", "The request failed on the server.", "Try again in a moment.");
  const status = NOT_FOUND.has(code) ? 404 : code === "web_approvals_off" ? 403 : CONFLICT.test(code) || code === "NO_HUMAN_CHANNEL" ? 409 : 400;
  return engineError(c, err, status);
}

type Guarded = { engine: HaggleEngine; mode: "mock" | "live"; workspaceId: string; actor: string | null };
async function guard(c: ServiceContext, needActor: boolean): Promise<Guarded | Response> {
  const g = await serviceGuard(c, { workspace: true });
  if (g instanceof Response) return g;
  if (!webApprovalsOn()) return fail(c, 403, "WEB_APPROVALS_OFF", "Approving in the web app is off on this server.", "Approve by replying to Haggle's text, or ask the operator to unset HAGGLE_WEB_APPROVALS=false.");
  if (needActor && !g.actor) return fail(c, 400, "ACTOR_REQUIRED", "This decision must name the signed-in user.", "Send x-haggle-actor with the user's email or id.");
  return { engine: g.rt.engine, mode: g.rt.mode, workspaceId: g.workspaceId!, actor: g.actor };
}

async function body<T extends z.ZodTypeAny>(c: ServiceContext, schema: T, fields: string): Promise<z.infer<T> | Response> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : fail(c, 400, "INVALID_INPUT", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), `Send ${fields}.`);
}

const usd = (cents: number) => Math.round(cents) / 100;
const rail = (e: HaggleEngine) => (e.manualHandoff ? "manual" : "charge") as "manual" | "charge";
/** The deal's state and next step after an action (the purchase stage on the manual rail). */
async function after(e: HaggleEngine, jobId: string) {
  const n = await e.webNext(jobId);
  return { state: n.state, ...(n.stage ? { stage: n.stage } : {}), ...(n.summary ? { summary: n.summary } : {}), next: n.next };
}

export function registerApprovalRoutes(app: ServiceApp) {
  app.post("/internal/approvals/request", async (c) => {
    const g = await guard(c, false);
    if (g instanceof Response) return g;
    const b = await body(c, Bodies.request, "job_id, quote_id and optional action (pay or confirm)");
    if (b instanceof Response) return b;
    try {
      const r = await g.engine.requestWebApproval(g.workspaceId, b.job_id, b.quote_id, b.action, g.actor);
      const a = r.approval;
      return c.json({
        ok: true, mode: g.mode, payment_rail: rail(g.engine), approval_id: a.id, status: a.status, action: a.action === "confirm" ? "confirm" : "pay",
        amount_usd: usd(a.payment_cents), quote_total_usd: usd(a.quote_total_cents), business: r.business, caveats: r.caveats, expires_at: a.expires_at,
        next: a.status === "pending" ? "Show the human the business, the amount paid now, the total and the caveats; their click decides (POST /internal/approvals/decide)." : "Already decided; see the deal.",
      });
    } catch (err) {
      return refusal(c, err);
    }
  });

  app.post("/internal/approvals/decide", async (c) => {
    const g = await guard(c, true);
    if (g instanceof Response) return g;
    const b = await body(c, Bodies.decide, "approval_id and decision (approve or decline)");
    if (b instanceof Response) return b;
    try {
      const r = await g.engine.decideWebApproval(g.workspaceId, b.approval_id, b.decision, g.actor);
      const a = r.approval;
      return c.json({
        ok: true, mode: g.mode, payment_rail: rail(g.engine), approval_id: a.id, decision: b.decision, status: a.status, changed: r.changed,
        action: a.action === "confirm" ? "confirm" : "pay", amount_usd: usd(a.payment_cents), quote_total_usd: usd(a.quote_total_cents), decided_at: a.decided_at,
        ...(await after(g.engine, a.job_id)),
      });
    } catch (err) {
      return refusal(c, err);
    }
  });

  app.post("/internal/purchases/paid", async (c) => {
    const g = await guard(c, true);
    if (g instanceof Response) return g;
    const b = await body(c, Bodies.job, "job_id");
    if (b instanceof Response) return b;
    try {
      const r = await g.engine.reportPaidByWeb(g.workspaceId, b.job_id, g.actor);
      return c.json({ ok: true, mode: g.mode, outcome: r.outcome, ...(await after(g.engine, b.job_id)) });
    } catch (err) {
      return refusal(c, err);
    }
  });

  app.post("/internal/purchases/booked", async (c) => {
    const g = await guard(c, true);
    if (g instanceof Response) return g;
    const b = await body(c, Bodies.job, "job_id");
    if (b instanceof Response) return b;
    try {
      const r = await g.engine.acceptBookingByWeb(g.workspaceId, b.job_id, g.actor);
      return c.json({ ok: true, mode: g.mode, outcome: r.outcome, ...(await after(g.engine, b.job_id)) });
    } catch (err) {
      return refusal(c, err);
    }
  });

  app.post("/internal/purchases/cancel", async (c) => {
    const g = await guard(c, true);
    if (g instanceof Response) return g;
    const b = await body(c, Bodies.job, "job_id");
    if (b instanceof Response) return b;
    try {
      const r = await g.engine.cancelByWeb(g.workspaceId, b.job_id, g.actor);
      return c.json({ ok: true, mode: g.mode, state: r.state, ...(r.flagged ? { flagged: true } : {}), ...(r.note ? { note: r.note } : {}), next: (await after(g.engine, b.job_id)).next });
    } catch (err) {
      return refusal(c, err);
    }
  });

  app.post("/internal/callbacks/authorize", async (c) => {
    const g = await guard(c, true);
    if (g instanceof Response) return g;
    const b = await body(c, Bodies.callback, "job_id and business_id");
    if (b instanceof Response) return b;
    try {
      const r = await g.engine.authorizeCallbackByWeb(g.workspaceId, b.job_id, b.business_id, g.actor);
      return c.json({
        ok: true, mode: g.mode, status: r.placed ? "placed" : "declined", business: r.proposal.business, ...(r.scheduledFor ? { scheduled_for: r.scheduledFor } : {}),
        next: r.scheduledFor ? "The callback is scheduled (call hours or a recent call); the deal updates when it ends." : "The deal updates when the call ends (wait_for_update).",
      });
    } catch (err) {
      return refusal(c, err);
    }
  });
}
