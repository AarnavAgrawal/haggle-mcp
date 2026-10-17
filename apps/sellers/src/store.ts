/** Conversation state per thread and the identity registry written by scripts/setup.ts. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThreadState } from "./logic.ts";

/** Repo-root .haggle-data (gitignored), whatever directory npm runs the script from. */
export const DATA_DIR = join(fileURLToPath(new URL("../../../", import.meta.url)), ".haggle-data");

export class StateStore {
  private readonly path: string | undefined;
  private readonly threads: Map<string, ThreadState>;

  /** No path = memory only (tests). */
  constructor(path?: string) {
    this.path = path;
    this.threads = new Map(path && existsSync(path) ? Object.entries(JSON.parse(readFileSync(path, "utf8")) as Record<string, ThreadState>) : []);
  }

  get(key: string): ThreadState | undefined {
    return this.threads.get(key);
  }

  set(key: string, state: ThreadState): void {
    this.threads.set(key, state);
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(Object.fromEntries(this.threads), null, 2));
    renameSync(`${this.path}.tmp`, this.path);
  }
}

export interface IdentityRecord {
  identityId: string;
  email?: string;
  phone?: string;
  cardUrl?: string;
  /** Webhook signing key (whsec_...). Lives only in the gitignored .haggle-data folder. */
  signingKey?: string;
}

export type Registry = Record<string, IdentityRecord>;

export const REGISTRY_PATH = process.env.SELLERS_IDENTITIES_FILE ?? join(DATA_DIR, "sellers-identities.json");

export function loadRegistry(path = REGISTRY_PATH): Registry {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Registry) : {};
}

export function saveRegistry(registry: Registry, path = REGISTRY_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(registry, null, 2));
}
