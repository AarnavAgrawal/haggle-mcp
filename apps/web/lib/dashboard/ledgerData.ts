// The workspace ledger and the owner's settings for the admin pages, loaded at most once per request
// (React cache). One service read returns every deal: a board per deal is far too slow on a live server.
// Never throws: a failure comes back as { error } for the page to show with its fix.
import { cache } from "react";
import { callService, HaggleError } from "@/lib/haggle";
import type { WorkspaceSettings } from "@/lib/settings/types";
import { vendorServiceConfig } from "@/lib/vendors/deps";
import { requireHaggle } from "@/lib/workspace";
import type { Ledger } from "./ledger";

export type LedgerResult = { ledger: Ledger; error?: undefined } | { ledger?: undefined; error: { message: string; fix: string } };

export const loadLedger = cache(async (): Promise<LedgerResult> => {
  const { workspaceId } = await requireHaggle();
  try {
    return { ledger: await callService<Ledger>(vendorServiceConfig(), "/internal/workspaces/ledger?limit=50", { workspaceId }) };
  } catch (err) {
    return { error: err instanceof HaggleError ? { message: err.message, fix: err.fix } : { message: "The Haggle server couldn't be reached.", fix: "Try again in a moment." } };
  }
});

/** The workspace's limits and approver for the overview; null when they can't be read (the panel says so). */
export const loadSettings = cache(async (): Promise<WorkspaceSettings | null> => {
  const { workspaceId } = await requireHaggle();
  try {
    return (await callService<{ settings: WorkspaceSettings }>(vendorServiceConfig(), "/internal/workspaces/settings", { workspaceId })).settings;
  } catch {
    return null;
  }
});
