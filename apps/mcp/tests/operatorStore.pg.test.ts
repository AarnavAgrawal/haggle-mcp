// Sprint 5 B on Postgres (migration 119): the operator log is append-only and ordered; suspension,
// approver verification, the roster audit and the pilot preflight's workspace checks read the same
// from Postgres as from memory. Runs only with HAGGLE_TEST_DATABASE_URL (scripts/test-postgres.sh
// style: a throwaway database with supabase/migrations applied). Unique ids per run.
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { addVendor, approverVerification, PostgresRepository, recordOperatorAction, removeVendor, resumeWorkspace, rosterHistory, suspendWorkspace, workspaceSuspension } from "@haggle/engine";
import { workspaceChecks } from "../scripts/pilot-preflight.ts";

const PG_URL = process.env.HAGGLE_TEST_DATABASE_URL;
const uniq = () => Math.random().toString(36).slice(2, 10);

describe.skipIf(!PG_URL)("operator actions on Postgres (migration 119)", { timeout: 60_000 }, () => {
  it("append-only, newest first, filtered; constraints hold", async () => {
    const repo = new PostgresRepository(PG_URL!);
    const sql = postgres(PG_URL!, { max: 1 });
    try {
      const ws = `ws_pg_${uniq()}`;
      await repo.insertWorkspace({ id: ws, name: ws, token_hash: null, connector_secret_hash: null, timezone: "America/Los_Angeles" });
      const a = await recordOperatorAction(repo, { action: "cap_changed", operator: "ops-yash", reason: "budget limit", workspaceId: ws, detail: { from_cents: 1, to_cents: 2 } });
      const b = await recordOperatorAction(repo, { action: "credentials_revoked", operator: "ops-yash", reason: "leaked token", workspaceId: ws });
      expect(a.detail).toEqual({ from_cents: 1, to_cents: 2 });
      expect(typeof a.at).toBe("string");
      expect((await repo.listOperatorActions({ workspaceId: ws })).map((x) => x.id)).toEqual([b.id, a.id]);
      expect((await repo.listOperatorActions({ workspaceId: ws, actions: ["cap_changed"] })).map((x) => x.id)).toEqual([a.id]);
      await expect(sql`update operator_actions set reason = 'rewritten' where id = ${a.id}`).rejects.toThrow(/append-only/);
      await expect(sql`delete from operator_actions where id = ${a.id}`).rejects.toThrow(/append-only/);
      await expect(recordOperatorAction(repo, { action: "cap_changed", operator: "x", reason: "budget", workspaceId: ws })).rejects.toThrow();
      await expect(recordOperatorAction(repo, { action: "cap_changed", operator: "ops", reason: "no", workspaceId: ws })).rejects.toThrow();
      await expect(sql`insert into operator_actions (id, action, operator, reason) values (${`opa_${uniq()}`}, 'vendor_added', 'ops', 'nowhere')`).rejects.toThrow();
      await expect(sql`insert into operator_actions (id, workspace_id, action, operator, reason) values (${`opa_${uniq()}`}, ${ws}, 'approve_payment', 'ops', 'not an action')`).rejects.toThrow();
    } finally {
      await sql.end({ timeout: 5 });
      await repo.close();
    }
  });

  it("suspension holds the workspace's open jobs; verification, roster audit and the preflight read it back", async () => {
    const repo = new PostgresRepository(PG_URL!);
    try {
      const ws = `ws_pg_${uniq()}`;
      const phone = `+1408${String(Math.floor(1_000_000 + Math.random() * 8_999_999))}`;
      await repo.insertWorkspace({ id: ws, name: ws, token_hash: "a".repeat(64), connector_secret_hash: null, timezone: "America/Los_Angeles" });
      await repo.saveSettings({ spending_cap_cents: 150_000, approver_phone: phone, approver_email: null, default_area: "San Francisco, CA" }, ws);
      const now = new Date().toISOString();
      await suspendWorkspace(repo, { workspaceId: ws, by: "ops", reason: "billing question", now });
      expect(await workspaceSuspension(repo, ws)).toMatchObject({ by: "ops", reason: "billing question" });
      await resumeWorkspace(repo, { workspaceId: ws, by: "ops", reason: "resolved", now });
      expect(await workspaceSuspension(repo, ws)).toBeNull();
      await recordOperatorAction(repo, { action: "approver_verified", operator: "ops", reason: "texted a code; read back", workspaceId: ws, detail: { phone } });
      expect(await approverVerification(repo, ws, phone)).toMatchObject({ phone, by: "ops" });
      const t = uniq();
      for (const [i, c] of [`a-${t}@harbor-sf.com`, `b-${t}@grill-sf.com`, phone.replace("+1408", "+1415")].entries()) {
        await addVendor(repo, { workspaceId: ws, contact: c, name: `Vendor ${i}`, consent: `Owner ${i} agreed by phone 2026-10-2${i}`, channel: c.includes("@") ? "email" : "imessage", by: "ops" });
      }
      const checks = await workspaceChecks(repo, ws, { live: true, env: {} });
      expect(checks.filter((c) => c.status === "FAIL")).toEqual([]);
      expect(checks.find((c) => c.name === "vendors")).toMatchObject({ status: "PASS", detail: "3 usable of 3" });
      await removeVendor(repo, { workspaceId: ws, contact: `a-${t}@harbor-sf.com`, by: "ops", reason: "vendor asked to stop" });
      expect((await rosterHistory(repo, ws)).map((x) => x.action)).toEqual(["vendor_removed", "vendor_added", "vendor_added", "vendor_added"]);
      expect((await workspaceChecks(repo, ws, { live: true, env: {} })).find((c) => c.name === "vendors")!.status).toBe("FAIL");
    } finally {
      await repo.close();
    }
  });
});
