/**
 * The business directory discovery searches. Defaults to fixtures/brain/directory.json (our simulated
 * seller fleet); `apps/sellers` setup writes the real Inkbox addresses and numbers to an override file
 * (HAGGLE_DIRECTORY_FILE), merged over the defaults by id.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { Business, type Channel } from "@haggle/core";
import defaults from "../../../fixtures/brain/directory.json" with { type: "json" };

export const DirectoryEntry = Business.omit({ best_channel: true }).extend({
  category: z.string(),
  area: z.string(),
});
export type DirectoryEntry = z.infer<typeof DirectoryEntry>;

/** CLAUDE.md §6 routing: A2A if the business has an Agent Card; else email; else a Voice AI call. */
export function routeChannel(e: Pick<DirectoryEntry, "a2a_card_url" | "email" | "phone">): Channel {
  if (e.a2a_card_url) return "a2a";
  if (e.email) return "email";
  if (e.phone) return "phone";
  return "email";
}

const Overrides = z.array(DirectoryEntry.partial().extend({ id: z.string() }));

/**
 * Overrides come from HAGGLE_DIRECTORY_FILE (local runs) or HAGGLE_DIRECTORY_JSON (the same JSON
 * inline, for hosted deploys that have no data folder); the inline one wins.
 */
export function loadDirectory(
  overridePath: string | undefined = process.env.HAGGLE_DIRECTORY_FILE,
  inline: string | undefined = process.env.HAGGLE_DIRECTORY_JSON,
): DirectoryEntry[] {
  const base = z.array(DirectoryEntry).parse(defaults);
  const overrides: DirectoryEntry[] = [];
  if (overridePath) {
    try {
      overrides.push(...(Overrides.parse(JSON.parse(readFileSync(overridePath, "utf8"))) as DirectoryEntry[]));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Bad directory override at ${overridePath}: ${(e as Error).message}`);
    }
  }
  if (inline?.trim()) {
    try {
      overrides.push(...(Overrides.parse(JSON.parse(inline)) as DirectoryEntry[]));
    } catch (e) {
      throw new Error(`Bad HAGGLE_DIRECTORY_JSON: ${(e as Error).message}`);
    }
  }
  if (!overrides.length) return base;
  const byId = new Map(base.map((b) => [b.id, b]));
  for (const o of overrides) byId.set(o.id, DirectoryEntry.parse({ ...byId.get(o.id), ...o }));
  return [...byId.values()];
}
