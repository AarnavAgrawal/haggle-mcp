import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Profile } from "@haggle/core";
import { DEFAULT_WORKSPACE_ID, FileStore, MemoryStore, SupabaseStore, storeFromEnv, type ProfileStore } from "../index.ts";

const supabase = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key" };

describe("storeFromEnv", () => {
  it("uses Supabase in the public schema by default", () => {
    const store = storeFromEnv({ ...supabase });
    expect(store).toBeInstanceOf(SupabaseStore);
    expect((store as SupabaseStore).schema).toBe("public");
  });

  it("follows HAGGLE_DB_SCHEMA, like the engine, when the database is shared", () => {
    const store = storeFromEnv({ ...supabase, HAGGLE_DB_SCHEMA: " haggle " });
    expect((store as SupabaseStore).schema).toBe("haggle");
  });

  it("falls back to memory or a file without Supabase", () => {
    expect(storeFromEnv({ HAGGLE_BRAIN_STORE: "memory" })).toBeInstanceOf(MemoryStore);
    expect(storeFromEnv({})).toBeInstanceOf(FileStore);
  });
});

// ── tenancy: one store, a view per workspace ──

const profile = (business_id: string, typical: number): Profile => ({
  business_id, name: "Harbor Table", category: "catering", area: "SF", menu: [], best_channel: "email", channels_seen: ["email"], price_model: "per_unit",
  per_unit_usd: { low: typical, typical, high: typical }, flags_seen: [], asks_questions: false, n_quotes: 1, confidence: 0.5,
  history: [{ job_id: `job_${typical}`, date: "2026-10-17T12:00:00Z", channel: "email", kind: "quote", total_usd: typical * 10, per_unit_usd: typical, quantity: 10, round: 1 }],
  updated_at: "2026-10-17T12:00:00Z",
});

async function isolates(store: ProfileStore) {
  const alpha = store.forWorkspace!("ws_alpha");
  const beta = store.forWorkspace!("ws_beta");
  await alpha.put(profile("biz_harbor_table", 20));
  await beta.put(profile("biz_harbor_table", 40));
  expect((await alpha.get("biz_harbor_table"))?.per_unit_usd?.typical).toBe(20);
  expect((await beta.get("biz_harbor_table"))?.per_unit_usd?.typical).toBe(40);
  expect((await alpha.list()).map((p) => p.per_unit_usd?.typical)).toEqual([20]);
  expect((await beta.list()).map((p) => p.per_unit_usd?.typical)).toEqual([40]);
  // The unscoped API is the default workspace: it sees neither tenant's rows.
  expect(await store.get("biz_harbor_table")).toBeNull();
  expect(await store.list()).toEqual([]);
  await store.put(profile("biz_harbor_table", 30));
  expect((await store.forWorkspace!(DEFAULT_WORKSPACE_ID).get("biz_harbor_table"))?.per_unit_usd?.typical).toBe(30);
  expect((await alpha.get("biz_harbor_table"))?.per_unit_usd?.typical).toBe(20);
  // A put replaces only that workspace's row.
  await alpha.put(profile("biz_harbor_table", 22));
  expect((await alpha.list()).map((p) => p.per_unit_usd?.typical)).toEqual([22]);
  expect((await beta.get("biz_harbor_table"))?.per_unit_usd?.typical).toBe(40);
  expect(() => store.forWorkspace!("")).toThrow(/workspace/);
}

describe("workspace-scoped stores", () => {
  let dir = "";
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ""; });

  it("MemoryStore: each workspace sees only its own profiles; the unscoped API is ws_default", async () => {
    await isolates(new MemoryStore());
  });

  it("FileStore: the same, persisted with workspace_id on each entry, and a reload keeps them apart", async () => {
    dir = await mkdtemp(join(tmpdir(), "haggle-brain-"));
    const path = join(dir, "brain.json");
    await isolates(new FileStore(path));
    const raw = JSON.parse(await readFile(path, "utf8")) as { profiles: { workspace_id: string; business_id: string }[] };
    expect(raw.profiles.map((p) => p.workspace_id).sort()).toEqual(["ws_alpha", "ws_beta", "ws_default"]);
    const reloaded = new FileStore(path);
    expect((await reloaded.forWorkspace("ws_beta").get("biz_harbor_table"))?.per_unit_usd?.typical).toBe(40);
    expect((await reloaded.get("biz_harbor_table"))?.per_unit_usd?.typical).toBe(30);
  });

  it("FileStore: a legacy file (no workspace_id) reads as ws_default only", async () => {
    dir = await mkdtemp(join(tmpdir(), "haggle-brain-"));
    const path = join(dir, "brain.json");
    await writeFile(path, JSON.stringify({ profiles: [profile("biz_harbor_table", 25)] }));
    const store = new FileStore(path);
    expect((await store.get("biz_harbor_table"))?.per_unit_usd?.typical).toBe(25);
    expect(await store.forWorkspace("ws_alpha").get("biz_harbor_table")).toBeNull();
    expect(await store.forWorkspace("ws_alpha").list()).toEqual([]);
  });

  it("SupabaseStore: every read filters by workspace_id; writes carry it and upsert on (workspace_id, business_id)", async () => {
    const calls: unknown[][] = [];
    const rows = [{ profile: profile("biz_harbor_table", 20) }];
    const query = {
      select: (...a: unknown[]) => { calls.push(["select", ...a]); return query; },
      eq: (...a: unknown[]) => { calls.push(["eq", ...a]); return query; },
      maybeSingle: async () => { calls.push(["maybeSingle"]); return { data: rows[0], error: null }; },
      upsert: async (...a: unknown[]) => { calls.push(["upsert", ...a]); return { error: null }; },
      then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null }),
    };
    const client = { from: (t: string) => { calls.push(["from", t]); return query; } };
    const root = new SupabaseStore(supabase.SUPABASE_URL, supabase.SUPABASE_SERVICE_ROLE_KEY, "public", { client: client as never });
    const alpha = root.forWorkspace("ws_alpha");

    await alpha.get("biz_harbor_table");
    expect(calls).toEqual([["from", "brain_profiles"], ["select", "profile"], ["eq", "workspace_id", "ws_alpha"], ["eq", "business_id", "biz_harbor_table"], ["maybeSingle"]]);
    calls.length = 0;
    expect(await alpha.list()).toHaveLength(1);
    expect(calls).toEqual([["from", "brain_profiles"], ["select", "profile"], ["eq", "workspace_id", "ws_alpha"]]);
    calls.length = 0;
    await alpha.put(profile("biz_harbor_table", 20));
    expect(calls[1]![0]).toBe("upsert");
    expect(calls[1]![1]).toMatchObject({ workspace_id: "ws_alpha", business_id: "biz_harbor_table", category: "catering" });
    expect(calls[1]![2]).toEqual({ onConflict: "workspace_id,business_id" });
    calls.length = 0;
    await root.list();
    expect(calls).toContainEqual(["eq", "workspace_id", DEFAULT_WORKSPACE_ID]);
  });
});
