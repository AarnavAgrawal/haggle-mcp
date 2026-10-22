// Stalled-job detection (ops/stalled.ts, read-only) and the migration ledger comparison
// (ops/migrations.ts). Fake repositories; the real supabase/migrations folder for the file list.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareMigrations, findMigrationsDir, findStalledJobs, isEngineMigration, LEDGER_MIGRATION, migrationChecksum, repoMigrations, StalledJobMonitor, type JobRow, type MessageRow } from "../src/index.ts";

const NOW = new Date("2026-10-22T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const job = (id: string, state: JobRow["state"], updatedMinAgo: number, collectUntilMinAgo = -60): JobRow => ({
  id, workspace_id: "ws_default", short_code: id.slice(-4).toUpperCase(), state, mode: "live", request: {} as JobRow["request"], budget_cents: null, payment_cap_cents: 0, approver_email: null,
  inbox: "haggle@inkboxmail.test", round: 1, max_rounds: 2, collect_until: ago(collectUntilMinAgo), ready: false, pay_intent: false, failure_reason: null, client_request_id: null, version: 1, created_at: ago(600), updated_at: ago(updatedMinAgo),
});
const fakeRepo = (jobs: JobRow[], pending: Record<string, Partial<MessageRow>[]> = {}) => {
  const reads: string[] = [];
  return {
    reads,
    listOpenJobs: async () => { reads.push("listOpenJobs"); return jobs; },
    getPendingMessages: async (id: string) => { reads.push(`pending:${id}`); return (pending[id] ?? []) as MessageRow[]; },
  };
};

describe("stalled jobs", () => {
  it("reports jobs stuck past each state's threshold, and only those", async () => {
    const repo = fakeRepo([
      job("job_created_ok", "created", 3), job("job_created_stuck", "created", 30),
      job("job_contacting_stuck", "contacting", 45), job("job_collecting_ok", "collecting", 50, -10),
      job("job_past_deadline", "collecting", 40, 60), job("job_negotiating_recent", "negotiating", 5, 60),
      job("job_paying_stuck", "paying", 31), job("job_awaiting", "awaiting_approval", 600),
    ], { job_collecting_ok: [{ created_at: ago(20) }], job_awaiting: [{ created_at: ago(5) }] });
    const found = await findStalledJobs(repo, NOW);
    expect(found.map((j) => `${j.job_id}:${j.reason}`).sort()).toEqual([
      "job_collecting_ok:unparsed_reply", "job_contacting_stuck:stuck_contacting", "job_created_stuck:stuck_created", "job_past_deadline:past_deadline", "job_paying_stuck:stuck_paying",
    ]);
    expect(found.find((j) => j.reason === "past_deadline")).toMatchObject({ age_s: 3600, workspace_id: "ws_default" });
    // Read-only: only list/read calls were made.
    expect(repo.reads.every((r) => r === "listOpenJobs" || r.startsWith("pending:"))).toBe(true);
  });

  it("the monitor logs and alerts each stalled job once, again only after it recovers and stalls again", async () => {
    const jobs = [job("job_a", "contacting", 45)];
    const repo = fakeRepo(jobs);
    const logs: string[] = [];
    const alerts: { key: string; severity: string }[] = [];
    const m = new StalledJobMonitor({ repo, now: () => NOW, log: (e, d) => logs.push(`${e}:${d.job_id}`), alert: async (a) => { alerts.push(a); } });
    await m.check();
    await m.check();
    expect(logs).toEqual(["job_stalled:job_a"]);
    expect(alerts).toEqual([expect.objectContaining({ key: "stalled:job_a:stuck_contacting", severity: "warn" })]);
    jobs[0] = job("job_a", "collecting", 1);
    expect(await m.check()).toEqual([]);
    jobs[0] = job("job_a", "contacting", 45);
    await m.check();
    expect(logs).toHaveLength(2);
    expect(m.lastReport()).toMatchObject({ count: 1 });
  });

  it("a stuck payment is critical; an alert failure never breaks the check", async () => {
    const m = new StalledJobMonitor({ repo: fakeRepo([job("job_p", "paying", 60)]), now: () => NOW, alert: async () => { throw new Error("webhook down"); } });
    await expect(m.check()).resolves.toHaveLength(1);
    const seen: string[] = [];
    await new StalledJobMonitor({ repo: fakeRepo([job("job_p", "paying", 60)]), now: () => NOW, alert: async (a) => { seen.push(a.severity); } }).check();
    expect(seen).toEqual(["critical"]);
  });
});

describe("migration ledger", () => {
  const repo = [{ name: "100_engine_core.sql", checksum: "a".repeat(64) }, { name: "106_engine_pilot.sql", checksum: "b".repeat(64) }, { name: LEDGER_MIGRATION, checksum: "c".repeat(64) }, { name: "200_brain_profiles.sql", checksum: "d".repeat(64) }];
  const at = "2026-10-22T00:00:00.000Z";

  it("no ledger table: everything pending, not ok", () => {
    expect(compareMigrations(repo, null, isEngineMigration)).toMatchObject({ ledger: "absent", ok: false, pending: repo.map((m) => m.name) });
  });

  it("classifies applied, drifted, unverified, pending and unknown; only engine files decide ok", () => {
    const s = compareMigrations(repo, [
      { name: "100_engine_core.sql", checksum: "a".repeat(64), applied_at: at },
      { name: "106_engine_pilot.sql", checksum: "e".repeat(64), applied_at: at },
      { name: LEDGER_MIGRATION, checksum: null, applied_at: at },
      { name: "107_engine_other_branch.sql", checksum: "f".repeat(64), applied_at: at },
    ], isEngineMigration);
    expect(s).toMatchObject({ ledger: "present", applied: ["100_engine_core.sql"], drift: ["106_engine_pilot.sql"], unverified: [LEDGER_MIGRATION], pending: ["200_brain_profiles.sql"], unknown: ["107_engine_other_branch.sql"], ok: false });
    const good = compareMigrations(repo, repo.filter((m) => isEngineMigration(m.name)).map((m) => ({ ...m, applied_at: at })), isEngineMigration);
    expect(good).toMatchObject({ ok: true, pending: ["200_brain_profiles.sql"] }); // the brain's files don't block the engine
  });

  it("hashes the repo's real migrations (line endings normalized) and finds the folder from anywhere inside the repo", () => {
    const dir = findMigrationsDir(join(import.meta.dirname, "..", "src", "ops"));
    expect(dir).toBeTruthy();
    const files = repoMigrations(dir!);
    expect(files.map((f) => f.name)).toContain(LEDGER_MIGRATION);
    expect(files.map((f) => f.name)).toContain("100_engine_core.sql");
    expect(files.every((f) => /^[0-9a-f]{64}$/.test(f.checksum))).toBe(true);
    expect(migrationChecksum("select 1;\r\nselect 2;\r\n")).toBe(migrationChecksum("select 1;\nselect 2;\n"));
    expect(isEngineMigration("111_engine_ops.sql")).toBe(true);
    expect(isEngineMigration("200_brain_profiles.sql")).toBe(false);
  });
});
