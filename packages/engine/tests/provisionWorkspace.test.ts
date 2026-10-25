// provisionWorkspace (the web app's POST /internal/workspaces) under races and partial failures:
// only a unique violation on insert counts as "another request created it"; the row found then must
// be this request's (name, timezone, settings), never another owner's; a workspace row left without
// its settings (approver, cap) is completed, never reported as provisioned. In memory always, and on
// Postgres when HAGGLE_TEST_DATABASE_URL is set (scripts/test-postgres.sh).
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryRepository, PostgresRepository, type Repository } from "../src/index.ts";
import { kit } from "./helpers/reliabilityKit.ts";

const PG_URL = process.env.HAGGLE_TEST_DATABASE_URL;
const h = (s: string) => createHash("sha256").update(s).digest("hex");
const tag = () => randomUUID().replace(/-/g, "").slice(0, 12);

const repos: [string, () => Promise<{ repo: Repository; close: () => Promise<void> }>][] = [["memory", async () => ({ repo: new InMemoryRepository(), close: async () => {} })]];
if (PG_URL) repos.push(["postgres", async () => { const repo = new PostgresRepository(PG_URL); return { repo, close: () => repo.close() }; }]);

/** A plan as apps/mcp planServiceWorkspace builds it: fresh credential hashes per request. */
const plan = (id: string, over: { name?: string; cap?: number; phone?: string | null } = {}) => ({
  id, name: over.name ?? "Guest workspace", tokenHash: h(randomUUID()), connectorSecretHash: h(randomUUID()), timezone: "America/Los_Angeles",
  settings: { spending_cap_cents: over.cap ?? 70_000, approver_phone: over.phone ?? null, approver_email: "ada@example.com", default_area: null },
});

/** The repository with some calls replaced (the rest pass through, bound). */
const patched = (repo: Repository, over: Partial<Record<keyof Repository, unknown>>) =>
  new Proxy(repo, { get(t, p, r) { if (p in over) return over[p as keyof Repository]; const v = Reflect.get(t, p, r); return typeof v === "function" ? v.bind(t) : v; } }) as Repository;

/** getWorkspace answers null once (the read before our insert lost the race), then the truth. */
const raceOnce = (repo: Repository) => {
  let first = true;
  return (id: string) => (first ? ((first = false), Promise.resolve(null)) : repo.getWorkspace(id));
};

describe.each(repos)("provisionWorkspace on %s", (_name, open) => {
  it("two concurrent first requests for one owner both get the workspace, with its settings", async () => {
    const { repo, close } = await open();
    try {
      const k = kit({}, { repo: repo as never });
      const id = `ws_u_${tag()}`;
      const both = await Promise.all([k.engine.provisionWorkspace(plan(id)), k.engine.provisionWorkspace(plan(id))]);
      expect(both.map((r) => r.workspace.id)).toEqual([id, id]);
      expect(both.map((r) => r.created).sort()).toEqual([false, true]);
      expect(await repo.getSettings(id)).toMatchObject({ spending_cap_cents: 70_000, approver_email: "ada@example.com" });
    } finally {
      await close();
    }
  });

  it("an insert error that isn't a unique violation is rethrown, even if a row is there now; a retry completes the settings", async () => {
    const { repo, close } = await open();
    try {
      const id = `ws_u_${tag()}`;
      // The insert reached the database, then the connection dropped (not a race).
      const flaky = patched(repo, { insertWorkspace: async (w: Parameters<Repository["insertWorkspace"]>[0]) => { await repo.insertWorkspace(w); throw Object.assign(new Error("connection terminated unexpectedly"), { code: "57P01" }); } });
      const k = kit({}, { repo: flaky as never });
      await expect(k.engine.provisionWorkspace(plan(id))).rejects.toThrow(/connection terminated/);
      expect(await repo.getSettings(id)).toBeNull(); // half-created: the row without its settings
      const retry = await kit({}, { repo: repo as never }).engine.provisionWorkspace(plan(id));
      expect(retry).toMatchObject({ created: false, workspace: { id } });
      expect(await repo.getSettings(id)).toMatchObject({ spending_cap_cents: 70_000, approver_email: "ada@example.com" });
    } finally {
      await close();
    }
  });

  it("a race that finds another request's workspace (different name or settings) is refused, and nothing of it changes", async () => {
    const { repo, close } = await open();
    try {
      const id = `ws_u_${tag()}`;
      await kit({}, { repo: repo as never }).engine.provisionWorkspace(plan(id, { name: "Owner A", cap: 50_000 }));
      const k = kit({}, { repo: patched(repo, { getWorkspace: raceOnce(repo) }) as never });
      await expect(k.engine.provisionWorkspace(plan(id, { name: "Owner B", cap: 90_000 }))).rejects.toMatchObject({ code: "workspace_conflict" });
      const k2 = kit({}, { repo: patched(repo, { getWorkspace: raceOnce(repo) }) as never });
      await expect(k2.engine.provisionWorkspace(plan(id, { name: "Owner A", cap: 90_000 }))).rejects.toMatchObject({ code: "workspace_conflict" }); // same name, other settings
      expect(await repo.getWorkspace(id)).toMatchObject({ name: "Owner A" });
      expect(await repo.getSettings(id)).toMatchObject({ spending_cap_cents: 50_000 });
    } finally {
      await close();
    }
  });

  it("a race that finds this request's workspace still without settings completes them (idempotent), never reports a half-created one", async () => {
    const { repo, close } = await open();
    try {
      const id = `ws_u_${tag()}`;
      const p = plan(id);
      // The other request inserted the row and hasn't written its settings yet.
      await repo.insertWorkspace({ id, name: p.name, token_hash: h(randomUUID()), connector_secret_hash: h(randomUUID()), timezone: p.timezone });
      const k = kit({}, { repo: patched(repo, { getWorkspace: raceOnce(repo) }) as never });
      expect(await k.engine.provisionWorkspace(p)).toMatchObject({ created: false, workspace: { id } });
      expect(await repo.getSettings(id)).toMatchObject({ spending_cap_cents: 70_000, approver_email: "ada@example.com" });
    } finally {
      await close();
    }
  });
});
