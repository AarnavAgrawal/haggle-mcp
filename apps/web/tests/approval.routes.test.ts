// The approve / pay / callback route logic (lib/approval/route.ts) with fake auth and a fake Haggle
// client: 401/403 JSON (never a redirect), body validation, the per-user rate limit, a double click
// joining the first request, and error statuses. No network, no Next, no Supabase.
import { describe, expect, it } from "vitest";
import { handleAction, RateLimiter, type RouteDeps } from "../lib/approval/route.ts";
import type { HostClient } from "../lib/approval/flow.ts";
import { HaggleError, type ToolResult } from "../lib/haggle.ts";

const post = (body: unknown) => new Request("http://web.test/api/deals/job_1/approve", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

function deps(over: Partial<RouteDeps> = {}, client?: Partial<HostClient>): RouteDeps & { calls: string[] } {
  const calls: string[] = [];
  const reply = async <T,>(name: string): Promise<ToolResult<T>> => {
    calls.push(name);
    if (name === "choose_in_view") return { data: { status: "pending", mode: "mock", amount_usd: 5 } as T, text: "", meta: { "haggle/approval": { approval_id: "ap_1", code: "4821" } } };
    if (name === "approve_in_view") return { data: { status: "approved", outcome: "approved", mode: "mock", next: "pay next", card: { amount_usd: 5 } } as T, text: "" };
    if (name === "pay") return { data: { status: "paid", amount_usd: 5, mode: "mock", next: "Done." } as T, text: "" };
    throw new HaggleError("RPC_ERROR", name, "");
  };
  return {
    calls,
    auth: async () => ({ userId: "u1", workspaceId: "ws_u_1" }),
    client: () => ({ callTool: reply, callToolAsHost: reply, ...client }),
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
    const f = await handleAction("pay", post({ quote_id: "q_1" }), "job_1", deps({ auth: async () => ({ status: 403 }) }));
    expect(f.status).toBe(403);
    expect(d.calls).toEqual([]);
  });

  it("validates the body and the job id", async () => {
    const d = deps();
    expect((await handleAction("approve", post({}), "job_1", d)).status).toBe(400);
    expect((await handleAction("approve", post({ quote_id: "q_1", action: "refund" }), "job_1", d)).status).toBe(400);
    expect((await handleAction("approve", post("not json"), "job_1", d)).status).toBe(400);
    expect((await handleAction("callback", post({ quote_id: "q_1" }), "job_1", d)).status).toBe(400);
    expect((await handleAction("pay", post({ quote_id: "q_1" }), "job 1/../x", d)).status).toBe(400);
    expect(d.calls).toEqual([]);
  });

  it("approves in one request and the response has no code", async () => {
    const d = deps();
    const r = await handleAction("approve", post({ quote_id: "q_1" }), "job_1", d);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(JSON.parse(body)).toMatchObject({ ok: true, status: "approved", amount_usd: 5 });
    expect(body).not.toContain("4821");
    expect(d.calls).toEqual(["choose_in_view", "approve_in_view"]);
  });

  it("a double click joins the request already running (one approval)", async () => {
    const d = deps();
    const [a, b] = await Promise.all([handleAction("approve", post({ quote_id: "q_1" }), "job_1", d), handleAction("approve", post({ quote_id: "q_1" }), "job_1", d)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(d.calls).toEqual(["choose_in_view", "approve_in_view"]);
  });

  it("rate limits per user", async () => {
    const d = deps({ limiter: new RateLimiter(2, 60_000) });
    expect((await handleAction("pay", post({ quote_id: "q_1" }), "job_1", d)).status).toBe(200);
    expect((await handleAction("pay", post({ quote_id: "q_1" }), "job_1", d)).status).toBe(200);
    const third = await handleAction("pay", post({ quote_id: "q_1" }), "job_1", d);
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({ error: { code: "rate_limited" } });
    // another user is not affected
    expect((await handleAction("pay", post({ quote_id: "q_1" }), "job_1", { ...d, auth: async () => ({ userId: "u2", workspaceId: "ws_u_2" }) })).status).toBe(200);
  });

  it("a window resets after a minute", () => {
    let t = 0;
    const l = new RateLimiter(1, 60_000, () => t);
    expect(l.take("u")).toBe(true);
    expect(l.take("u")).toBe(false);
    t = 60_000;
    expect(l.take("u")).toBe(true);
  });

  it("tool refusals are 422 with the fix; an unreachable server is 502", async () => {
    const refusing = deps({}, { callTool: async () => { throw new HaggleError("no_approval", "No stored human approval.", "Approve first.", "approve"); } });
    const r = await handleAction("pay", post({ quote_id: "q_1" }), "job_1", refusing);
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ ok: false, error: { code: "no_approval", message: "No stored human approval.", fix: "Approve first." }, next: "approve" });
    const down = deps({}, { callTool: async () => { throw new TypeError("fetch failed"); } });
    expect((await handleAction("pay", post({ quote_id: "q_1" }), "job_1", down)).status).toBe(502);
  });
});
