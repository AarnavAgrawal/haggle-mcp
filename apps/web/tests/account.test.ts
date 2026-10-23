// Account deletion order and data export (lib/account/{delete,export}.ts) with fakes: no Supabase, no server.
import { describe, expect, it } from "vitest";
import { deleteAccount, type DeleteDeps } from "../lib/account/delete.ts";
import { buildExport, type ExportDeps } from "../lib/account/export.ts";

function fakes(over: Partial<DeleteDeps> = {}, failAt?: string) {
  const calls: string[] = [];
  const step = (name: string, result?: unknown) => async () => {
    calls.push(name);
    if (name === failAt) throw new Error(`${name} broke`);
    return result as never;
  };
  const deps: DeleteDeps = {
    role: "owner",
    revoke: step("revoke", { cancelled: ["job_1"], not_cancelled: [{ job_id: "job_2", reason: "vendor confirmed" }] }),
    deleteThreads: step("threads"), deleteMemberships: step("memberships"), deleteProfile: step("profile"), deleteAuthUser: step("auth_user"), signOut: step("sign_out"),
    ...over,
  };
  return { deps, calls };
}

describe("deleteAccount", () => {
  it("revokes the workspace first, then chats, membership, profile, the sign-in, and signs out", async () => {
    const { deps, calls } = fakes();
    const r = await deleteAccount(deps);
    expect(calls).toEqual(["revoke", "threads", "memberships", "profile", "auth_user", "sign_out"]);
    expect(r).toMatchObject({ ok: true, cancelled: ["job_1"], not_cancelled: [{ job_id: "job_2" }] });
  });

  it("touches nothing else when the revoke fails", async () => {
    const { deps, calls } = fakes({}, "revoke");
    const r = await deleteAccount(deps);
    expect(calls).toEqual(["revoke"]);
    expect(r).toMatchObject({ ok: false, failed_at: "revoke", steps: [] });
  });

  it("stops at the first failing step and never deletes the sign-in before the data", async () => {
    const { deps, calls } = fakes({}, "memberships");
    const r = await deleteAccount(deps);
    expect(calls).toEqual(["revoke", "threads", "memberships"]);
    expect(r).toMatchObject({ ok: false, failed_at: "memberships", steps: ["revoke", "threads"] });
  });

  it("a plain member (or a user without a workspace) leaves the workspace running", async () => {
    for (const role of ["member", "none"]) {
      const { deps, calls } = fakes({ role });
      await deleteAccount(deps);
      expect(calls[0]).toBe("threads");
      expect(calls).not.toContain("revoke");
    }
  });

  it("a failed sign-out after the user is gone still counts as deleted", async () => {
    const { deps } = fakes({}, "sign_out");
    expect((await deleteAccount(deps)).ok).toBe(true);
  });
});

describe("buildExport", () => {
  const base = (over: Partial<ExportDeps> = {}): ExportDeps => ({
    user: { id: "u1", email: "ada@example.com" }, workspaceId: "ws_u_1",
    loadThreads: async () => [{ id: "t1", title: "Lunch", job_id: "job_1", created_at: "2026-10-01", updated_at: "2026-10-02" }],
    loadMessages: async () => [{ thread_id: "t1", role: "user", content: "Lunch for 40", created_at: "2026-10-01" }, { thread_id: "other", role: "user", content: "x", created_at: "" }],
    listDeals: async () => [{ job_id: "job_1", what: "lunch", state: "collecting" }, { job_id: "job_2", what: "dinner", state: "paid" }],
    getQuotes: async (id) => {
      if (id === "job_2") throw new Error("gone");
      return { job: { id }, quotes: [] };
    },
    now: () => new Date("2026-10-22T00:00:00Z"),
    ...over,
  });

  it("bundles the account, chats with their own messages, and each deal's board", async () => {
    const r = await buildExport(base());
    expect(r.account).toEqual({ user_id: "u1", email: "ada@example.com", workspace_id: "ws_u_1" });
    expect(r.generated_at).toBe("2026-10-22T00:00:00.000Z");
    expect(r.chat).toHaveLength(1);
    expect(r.chat[0]!.messages).toEqual([{ role: "user", content: "Lunch for 40", created_at: "2026-10-01" }]);
    expect(r.deals[0]).toMatchObject({ job_id: "job_1", board: { job: { id: "job_1" } } });
    expect(r.deals[1]).toMatchObject({ job_id: "job_2", board: null, error: "gone" });
  });

  it("still exports the chats when the MCP server can't list deals", async () => {
    const r = await buildExport(base({ listDeals: async () => { throw new Error("server down"); } }));
    expect(r.chat).toHaveLength(1);
    expect(r.deals).toEqual([]);
    expect(r).toMatchObject({ deals_error: "server down" });
  });
});
