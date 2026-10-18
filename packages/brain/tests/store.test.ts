import { describe, expect, it } from "vitest";
import { FileStore, MemoryStore, SupabaseStore, storeFromEnv } from "../index.ts";

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
