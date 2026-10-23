// The approve / pay / callback / purchase route logic (lib/approval/route.ts) with fake auth and a
// fake client: 401/403 JSON (never a redirect), body validation, the actor passed to the server,
// preview then decide, the per-user rate limit, a double click joining the first request, and error
// statuses. No network, no Next, no Supabase.
import { describe, expect, it } from "vitest";
import { handleAction, handlePurchaseStatus, RateLimiter, statusOf, type RouteDeps } from "../lib/approval/route.ts";
import type { ApprovalClient } from "../lib/approval/flow.ts";
import { HaggleError, type ToolResult } from "../lib/haggle.ts";

const post = (body: unknown) => new Request("http://web.test/api/deals/job_1/approve", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

function deps(over: Partial<RouteDeps> = {}, client?: Partial<ApprovalClient>): RouteDeps & { calls: string[]; actors: string[] } {
  const calls: string[] = [];
  const actors: string[] = [];
  const tool = async <T,>(name: string): Promise<ToolResult<T>> => {
    calls.push(name);
    if (name === "pay") return { data: { status: "paid", amount_usd: 5, mode: "mock", next: "Done." } as T, text: "" };
    if (name === "get_quotes") return { data: { mode: "mock", job: { state: "paid" }, payment: { status: "settled", simulated: true } } as T, text: "" };
    throw new HaggleError("RPC_ERROR", name, "");
  };
  const service = async <T,>(path: string): Promise<T> => {
    calls.push(path);
    if (path === "/internal/approvals/request") return { ok: true, mode: "mock", payment_rail: "charge", approval_id: "ap_1", status: "pending", action: "pay", amount_usd: 5, quote_total_usd: 995, business: "Bay Catering", caveats: [], code: "4821" } as T;
    if (path === "/internal/approvals/decide") return { ok: true, mode: "mock", status: "approved", changed: true, action: "pay", amount_usd: 5, quote_total_usd: 995, state: "paying", next: "pay next" } as T;
    if (path === "/internal/purchases/paid") return { ok: true, outcome: "reported", next: "" } as T;
    throw new HaggleError("HTTP_404", path, "", null, 404);
  };
  return {
    calls, actors,
    auth: async () => ({ userId: "u1", workspaceId: "ws_u_1", actor: "ada@example.com" }),
    client: (_ws, actor) => {
      actors.push(actor);
      return { callTool: tool, service, ...client };
    },
    limiter: new RateLimiter(30, 60_000),
    ...over,
  };
}

describe("approval routes", () => {
  it("401 signed out and 403 without a workspace, as JSON; nothing is called", async () => {
    const d = deps({ auth: async () => ({ status: 401 }) });
    const r = await handleAction("approve", post({ quote_id: "q_1" }), "job_1", d);
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ ok: false, error: { code: "signed_out" } });
    expect((await handleAction("pay", post({ quote_id: "q_1" }), "job_1", deps({ auth: async () => ({ status: 403 }) }))).status).toBe(403);
    expect((await handlePurchaseStatus("job_1", deps({ auth: async () => ({ status: 401 }) }))).status).toBe(401);
    expect(d.calls).toEqual([]);
  });

  it("validates the body and the job id", async () => {
    const d = deps();
    expect((await handleAction("approve", post({}), "job_1", d)).status).toBe(400);
    expect((await handleAction("approve", post({ quote_id: "q_1", action: "refund" }), "job_1", d)).status).toBe(400);
    expect((await handleAction("approve", post({ quote_id: "q_1", approval_id: "ap_1", decision: "maybe" }), "job_1", d)).status).toBe(400);
    expect((await handleAction("approve", post({ quote_id: "q_1", amount_usd: 1 }), "job_1", d)).status).toBe(400); // never an amount
    expect((await handleAction("approve", post("not json"), "job_1", d)).status).toBe(400);
    expect((await handleAction("callback", post({ quote_id: "q_1" }), "job_1", d)).status).toBe(400);
    expect((await handleAction("purchase", post({ action: "refund" }), "job_1", d)).status).toBe(400);
    expect((await handleAction("pay", post({ quote_id: "q_1" }), "job 1/../x", d)).status).toBe(400);
    expect(d.calls).toEqual([]);
  });

  it("preview then decide, as the signed-in user; no code in any response", async () => {
    const d = deps();
    const p = await handleAction("approve", post({ quote_id: "q_1" }), "job_1", d);
    expect(p.status).toBe(200);
    const pb = await p.text();
    expect(JSON.parse(pb)).toMatchObject({ ok: true, status: "pending", approval_id: "ap_1", amount_usd: 5, business: "Bay Catering" });
    expect(pb).not.toContain("4821");
    const r = await handleAction("approve", post({ quote_id: "q_1", approval_id: "ap_1", decision: "approve" }), "job_1", d);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, status: "approved", changed: true });
    expect(d.calls).toEqual(["/internal/approvals/request", "/internal/approvals/decide"]);
    expect(d.actors).toEqual(["ada@example.com", "ada@example.com"]);
  });

  it("a double click joins the request already running (one decision)", async () => {
    const d = deps();
    const body = { quote_id: "q_1", approval_id: "ap_1", decision: "approve" };
    const [a, b] = await Promise.all([handleAction("approve", post(body), "job_1", d), handleAction("approve", post(body), "job_1", d)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(d.calls).toEqual(["/internal/approvals/decide"]);
  });

  it("purchase: POST the human's step; GET where it stands", async () => {
    const d = deps();
    const r = await handleAction("purchase", post({ action: "paid" }), "job_1", d);
    expect(await r.json()).toMatchObject({ ok: true, action: "paid", outcome: "reported" });
    const s = await handlePurchaseStatus("job_1", d);
    expect(await s.json()).toMatchObject({ ok: true, rail: "charge", payment: { status: "settled" } });
    expect((await handlePurchaseStatus("bad id!", d)).status).toBe(400);
  });

  it("rate limits per user", async () => {
    const d = deps({ limiter: new RateLimiter(2, 60_000) });
    expect((await handleAction("pay", post({ quote_id: "q_1" }), "job_1", d)).status).toBe(200);
    expect((await handleAction("pay", post({ quote_id: "q_1" }), "job_1", d)).status).toBe(200);
    const third = await handleAction("pay", post({ quote_id: "q_1" }), "job_1", d);
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect((await handleAction("pay", post({ quote_id: "q_1" }), "job_1", { ...d, auth: async () => ({ userId: "u2", workspaceId: "ws_u_2", actor: "b@example.com" }) })).status).toBe(200);
  });

  it("a window resets after a minute", () => {
    let t = 0;
    const l = new RateLimiter(1, 60_000, () => t);
    expect(l.take("u")).toBe(true);
    expect(l.take("u")).toBe(false);
    t = 60_000;
    expect(l.take("u")).toBe(true);
  });

  it("tool refusals are 422 with the fix; server not-found 404, wrong stage 409; unreachable or a refused credential 502", async () => {
    const refusing = deps({}, { callTool: async () => { throw new HaggleError("no_approval", "No stored human approval.", "Approve first.", "approve"); } });
    const r = await handleAction("pay", post({ quote_id: "q_1" }), "job_1", refusing);
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ ok: false, error: { code: "no_approval", message: "No stored human approval.", fix: "Approve first." }, next: "approve" });
    const down = deps({}, { callTool: async () => { throw new TypeError("fetch failed"); } });
    expect((await handleAction("pay", post({ quote_id: "q_1" }), "job_1", down)).status).toBe(502);
    const e = (code: string, status: number) => ({ ok: false as const, error: { code, message: "", fix: "" }, next: null, status });
    expect(statusOf(e("approval_not_found", 404))).toBe(404);
    expect(statusOf(e("approval_expired", 409))).toBe(409);
    expect(statusOf(e("over_cap", 400))).toBe(422);
    expect(statusOf(e("WEB_APPROVALS_OFF", 403))).toBe(422);
    expect(statusOf(e("UNAUTHORIZED", 401))).toBe(502);
    expect(statusOf(e("INTERNAL", 500))).toBe(502);
  });
});
