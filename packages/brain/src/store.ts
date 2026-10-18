/**
 * Where profiles live. Memory for tests, a JSON file for local dev, Supabase for the deployed server.
 * Pick with storeFromEnv(): SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY → Supabase (schema HAGGLE_DB_SCHEMA, default public),
 * HAGGLE_BRAIN_STORE=memory → memory, otherwise a file at HAGGLE_BRAIN_FILE (.haggle-data/brain.json).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Profile } from "@haggle/core";

export interface ProfileStore {
  get(businessId: string): Promise<Profile | null>;
  list(): Promise<Profile[]>;
  put(profile: Profile): Promise<void>;
}

export class MemoryStore implements ProfileStore {
  private readonly profiles = new Map<string, Profile>();

  async get(businessId: string) {
    return this.profiles.get(businessId) ?? null;
  }
  async list() {
    return [...this.profiles.values()];
  }
  async put(profile: Profile) {
    this.profiles.set(profile.business_id, profile);
  }
}

export class FileStore implements ProfileStore {
  private readonly path: string;
  private cache: Map<string, Profile> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  private async load(): Promise<Map<string, Profile>> {
    if (this.cache) return this.cache;
    let profiles: Profile[] = [];
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as { profiles?: unknown[] };
      profiles = (raw.profiles ?? []).flatMap((p) => {
        const parsed = Profile.safeParse(p);
        return parsed.success ? [parsed.data] : [];
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    this.cache = new Map(profiles.map((p) => [p.business_id, p]));
    return this.cache;
  }

  async get(businessId: string) {
    return (await this.load()).get(businessId) ?? null;
  }
  async list() {
    return [...(await this.load()).values()];
  }
  async put(profile: Profile) {
    const all = await this.load();
    all.set(profile.business_id, profile);
    // Serialize writes and replace the file atomically so a crash never leaves half a JSON file.
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify({ profiles: [...all.values()] }, null, 2));
      await rename(tmp, this.path);
    });
    await this.writing;
  }
}

const TABLE = "brain_profiles";

export class SupabaseStore implements ProfileStore {
  // A shared database keeps the tables in another schema (HAGGLE_DB_SCHEMA), which must then be
  // in Supabase's exposed schemas; the client type is widened from its "public" default for it.
  private readonly db: SupabaseClient<any, string, string>;
  readonly schema: string;

  constructor(url: string, serviceRoleKey: string, schema = "public") {
    this.schema = schema;
    this.db = createClient<any, string>(url, serviceRoleKey, { auth: { persistSession: false }, db: { schema } });
  }

  async get(businessId: string) {
    const { data, error } = await this.db.from(TABLE).select("profile").eq("business_id", businessId).maybeSingle();
    if (error) throw new Error(`brain_profiles read failed: ${error.message}`);
    return data ? Profile.parse(data.profile) : null;
  }
  async list() {
    const { data, error } = await this.db.from(TABLE).select("profile");
    if (error) throw new Error(`brain_profiles list failed: ${error.message}`);
    return (data ?? []).flatMap((row) => {
      const parsed = Profile.safeParse(row.profile);
      return parsed.success ? [parsed.data] : [];
    });
  }
  async put(profile: Profile) {
    const { error } = await this.db.from(TABLE).upsert({
      business_id: profile.business_id,
      name: profile.name,
      category: profile.category,
      area: profile.area ?? null,
      profile,
      updated_at: profile.updated_at,
    });
    if (error) throw new Error(`brain_profiles write failed: ${error.message}`);
  }
}

export function storeFromEnv(env: NodeJS.ProcessEnv = process.env): ProfileStore {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    return new SupabaseStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, env.HAGGLE_DB_SCHEMA?.trim() || "public");
  }
  if (env.HAGGLE_BRAIN_STORE === "memory") return new MemoryStore();
  return new FileStore(env.HAGGLE_BRAIN_FILE ?? ".haggle-data/brain.json");
}
