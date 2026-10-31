// The workspace's deals (list_deals, newest 20), loaded at most once per request: the shell rail and
// the /deals page share the result (React cache). Never throws: a failure comes back as { error }.
import { cache } from "react";
import type { DealList } from "@/lib/dashboard/types";
import { HaggleError } from "@/lib/haggle";
import { requireHaggle } from "@/lib/workspace";

export type DealsResult = { deals: DealList; error?: undefined } | { deals?: undefined; error: { message: string; fix: string } };

export const loadDeals = cache(async (): Promise<DealsResult> => {
  const { haggle } = await requireHaggle();
  try {
    return { deals: (await haggle.callTool<DealList>("list_deals", { limit: 20 })).data };
  } catch (err) {
    return { error: err instanceof HaggleError ? { message: err.message, fix: err.fix } : { message: "The Haggle server couldn't be reached.", fix: "Try again in a moment." } };
  }
});
