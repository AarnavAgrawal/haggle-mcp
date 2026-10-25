/**
 * Where profiles live. Memory for tests, a JSON file for local dev, Supabase for the deployed server.
 * Pick with storeFromEnv(): SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY → Supabase (schema HAGGLE_DB_SCHEMA, default public),
 * HAGGLE_BRAIN_STORE=memory → memory, otherwise a file at HAGGLE_BRAIN_FILE (.haggle-data/brain.json).
 *
 * Tenancy: every profile belongs to one workspace (brain_profiles is keyed (workspace_id, business_id),
 * migration 202_brain_tenancy). `forWorkspace(ws)` is the same store seen as that workspace's profiles
 * only; the unscoped get/list/put are the default workspace's view (ws_default), never all of them.
 * A brain built over a workspace view (createWorkspaceBrains) can't read another workspace's rows.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Profile } from "@haggle/core";

/** The workspace of single-tenant servers and of the unscoped store API (the engine's DEFAULT_WORKSPACE_ID). */
export const DEFAULT_WORKSPACE_ID = "ws_default";

/**
 * Where 202_brain_tenancy parks the profiles learned before tenancy (pooled from every workspace's
 * deals, so no one tenant may read them). Reserved: no store view or brain is ever built for it, and
 * the engine never creates a workspace with this id (the engine's LEGACY_POOLED_WORKSPACE_ID).
 */
export const LEGACY_POOLED_WORKSPACE_ID = "ws_legacy_pooled";

/** The brain's table answers what this build queries (SupabaseStore.checkSchema; reasons only, never error text). */
export type SchemaCheck = { ok: true } | { ok: false; reason: "schema_missing" | "unreachable" };

export interface ProfileStore {
  get(businessId: string): Promise<Profile | null>;
  list(): Promise<Profile[]>;
  put(profile: Profile): Promise<void>;
  /** The same store seen as one workspace's profiles only (reads and writes). */
  forWorkspace?(workspaceId: string): ProfileStore;
  /** Stores with a database schema: a read-only probe that it has what this build queries (/ready). */
  checkSchema?(): Promise<SchemaCheck>;
}

/** A workspace id is required, never defaulted: an empty one would silently share the default view. */
export function checkWorkspaceId(workspaceId: string): string {
  if (typeof workspaceId !== "string" || !workspaceId.trim() || workspaceId.length > 64) {
    throw new Error(`brain: a workspace id is required (got ${JSON.stringify(workspaceId)})`);
  }
  if (workspaceId === LEGACY_POOLED_WORKSPACE_ID) {
    throw new Error(`brain: ${LEGACY_POOLED_WORKSPACE_ID} is reserved for the profiles pooled before tenancy (202_brain_tenancy); no workspace reads it`);
  }
  return workspaceId;
}

// PostgREST / Postgres codes for "the table or column this build queries isn't there":
// undefined_column, undefined_table, and PostgREST's schema-cache misses for a column and a table.
const SCHEMA_MISSING = new Set(["42703", "42P01", "PGRST204", "PGRST205"]);

type Tenants = Map<string, Map<string, Profile>>;

function tenant(all: Tenants, workspaceId: string): Map<string, Profile> {
  let own = all.get(workspaceId);
  if (!own) all.set(workspaceId, (own = new Map()));
  return own;
}

export class MemoryStore implements ProfileStore {
  readonly workspaceId: string;
  private readonly all: Tenants;

  /** `shared`: the tenants map of the store this is a view of (forWorkspace); omit for a new store. */
  constructor(workspaceId: string = DEFAULT_WORKSPACE_ID, shared: Tenants = new Map()) {
    this.workspaceId = checkWorkspaceId(workspaceId);
    this.all = shared;
  }

  async get(businessId: string) {
    return tenant(this.all, this.workspaceId).get(businessId) ?? null;
  }
  async list() {
    return [...tenant(this.all, this.workspaceId).values()];
  }
  async put(profile: Profile) {
    tenant(this.all, this.workspaceId).set(profile.business_id, profile);
  }
  forWorkspace(workspaceId: string): MemoryStore {
    return new MemoryStore(workspaceId, this.all);
  }
}

/** One file, every workspace: its cache and write queue are shared by all the file's views. */
interface FileState {
  path: string;
  cache: Tenants | null;
  writing: Promise<void>;
}

/**
 * `{ profiles: [{ ...profile, workspace_id }] }`. An entry without workspace_id (a file written before
 * tenancy) belongs to ws_default.
 */
export class FileStore implements ProfileStore {
  readonly workspaceId: string;
  private readonly state: FileState;

  constructor(path: string, workspaceId: string = DEFAULT_WORKSPACE_ID, state?: FileState) {
    this.workspaceId = checkWorkspaceId(workspaceId);
    this.state = state ?? { path, cache: null, writing: Promise.resolve() };
  }

  private async load(): Promise<Tenants> {
    if (this.state.cache) return this.state.cache;
    const all: Tenants = new Map();
    try {
      const raw = JSON.parse(await readFile(this.state.path, "utf8")) as { profiles?: unknown[] };
      for (const entry of raw.profiles ?? []) {
        const { workspace_id: ws, ...rest } = (entry ?? {}) as { workspace_id?: unknown };
        const parsed = Profile.safeParse(rest);
        if (!parsed.success) continue;
        tenant(all, typeof ws === "string" && ws ? ws : DEFAULT_WORKSPACE_ID).set(parsed.data.business_id, parsed.data);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    // Two first loads racing keep one cache (the first to finish), so no write is lost to the other.
    this.state.cache ??= all;
    return this.state.cache;
  }

  async get(businessId: string) {
    return tenant(await this.load(), this.workspaceId).get(businessId) ?? null;
  }
  async list() {
    return [...tenant(await this.load(), this.workspaceId).values()];
  }
  async put(profile: Profile) {
    const all = await this.load();
    tenant(all, this.workspaceId).set(profile.business_id, profile);
    const path = this.state.path;
    // Serialize writes and replace the file atomically so a crash never leaves half a JSON file.
    this.state.writing = this.state.writing.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      const profiles = [...all].flatMap(([workspace_id, own]) => [...own.values()].map((p) => ({ ...p, workspace_id })));
      await writeFile(tmp, JSON.stringify({ profiles }, null, 2));
      await rename(tmp, path);
    });
    await this.state.writing;
  }
  forWorkspace(workspaceId: string): FileStore {
    return new FileStore(this.state.path, workspaceId, this.state);
  }
}

const TABLE = "brain_profiles";

export class SupabaseStore implements ProfileStore {
  // A shared database keeps the tables in another schema (HAGGLE_DB_SCHEMA), which must then be
  // in Supabase's exposed schemas; the client type is widened from its "public" default for it.
  private readonly db: SupabaseClient<any, string, string>;
  readonly schema: string;
  readonly workspaceId: string;

  /** `client`: an existing client (a workspace view shares its parent's; tests inject a fake). */
  constructor(url: string, serviceRoleKey: string, schema = "public", opts: { client?: SupabaseClient<any, string, string>; workspaceId?: string } = {}) {
    this.schema = schema;
    this.workspaceId = checkWorkspaceId(opts.workspaceId ?? DEFAULT_WORKSPACE_ID);
    this.db = opts.client ?? createClient<any, string>(url, serviceRoleKey, { auth: { persistSession: false }, db: { schema } });
  }

  // Every query names the workspace: a read never returns, and a write never touches, another workspace's row.
  async get(businessId: string) {
    const { data, error } = await this.db.from(TABLE).select("profile").eq("workspace_id", this.workspaceId).eq("business_id", businessId).maybeSingle();
    if (error) throw new Error(`brain_profiles read failed: ${error.message}`);
    return data ? Profile.parse(data.profile) : null;
  }
  async list() {
    const { data, error } = await this.db.from(TABLE).select("profile").eq("workspace_id", this.workspaceId);
    if (error) throw new Error(`brain_profiles list failed: ${error.message}`);
    return (data ?? []).flatMap((row) => {
      const parsed = Profile.safeParse(row.profile);
      return parsed.success ? [parsed.data] : [];
    });
  }
  async put(profile: Profile) {
    const { error } = await this.db.from(TABLE).upsert(
      {
        workspace_id: this.workspaceId,
        business_id: profile.business_id,
        name: profile.name,
        category: profile.category,
        area: profile.area ?? null,
        profile,
        updated_at: profile.updated_at,
      },
      { onConflict: "workspace_id,business_id" },
    );
    if (error) throw new Error(`brain_profiles write failed: ${error.message}`);
  }
  forWorkspace(workspaceId: string): SupabaseStore {
    return new SupabaseStore("", "", this.schema, { client: this.db, workspaceId });
  }
  /**
   * Read-only: selects workspace_id (202_brain_tenancy's column) with limit 0, so no row is returned.
   * A missing column or table is schema_missing; any other failure is unreachable (the error text,
   * which can carry a URL, is not passed on).
   */
  async checkSchema(): Promise<SchemaCheck> {
    try {
      const { error } = await this.db.from(TABLE).select("workspace_id").limit(0);
      if (!error) return { ok: true };
      return { ok: false, reason: SCHEMA_MISSING.has(String((error as { code?: unknown }).code ?? "")) ? "schema_missing" : "unreachable" };
    } catch {
      return { ok: false, reason: "unreachable" };
    }
  }
}

export function storeFromEnv(env: NodeJS.ProcessEnv = process.env): ProfileStore {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    return new SupabaseStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, env.HAGGLE_DB_SCHEMA?.trim() || "public");
  }
  if (env.HAGGLE_BRAIN_STORE === "memory") return new MemoryStore();
  return new FileStore(env.HAGGLE_BRAIN_FILE ?? ".haggle-data/brain.json");
}
