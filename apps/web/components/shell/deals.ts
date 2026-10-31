// The app shell's deals list: list_deals rows grouped the way the rail and /deals show them, and the
// one status line each row carries. Pure (tested in tests/shell.test.ts).
import type { StatusTone } from "../ui/Status.tsx";
import { stateWords } from "../../lib/dashboard/format.ts";
import type { DealRow } from "../../lib/dashboard/types.ts";

export type DealGroupKey = "needs_you" | "in_progress" | "done";
export interface DealGroup {
  key: DealGroupKey;
  label: string;
  deals: DealRow[];
}

const NEEDS_YOU = new Set(["awaiting_approval", "paying"]);
const DONE = new Set(["paid", "confirmed", "cancelled", "failed"]);
const LABELS: Record<DealGroupKey, string> = { needs_you: "Needs you", in_progress: "In progress", done: "Done" };

export const dealGroupOf = (state: string): DealGroupKey => (NEEDS_YOU.has(state) ? "needs_you" : DONE.has(state) ? "done" : "in_progress");

/** Needs you (awaiting approval, paying), In progress, Done; empty groups left out; server order kept. */
export function groupDeals(deals: DealRow[]): DealGroup[] {
  const by: Record<DealGroupKey, DealRow[]> = { needs_you: [], in_progress: [], done: [] };
  for (const d of deals) by[dealGroupOf(d.state)].push(d);
  return (Object.keys(by) as DealGroupKey[]).filter((k) => by[k].length).map((k) => ({ key: k, label: LABELS[k], deals: by[k] }));
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The row's status line: a tone for the dot and the words ("2 of 5 quoted", "Needs your approval"). */
export function dealStatus(d: Pick<DealRow, "state" | "businesses" | "quotes">): { tone: StatusTone; words: string } {
  switch (d.state) {
    case "awaiting_approval":
      return { tone: "hold", words: "Needs your approval" };
    case "paying":
      return { tone: "hold", words: "Paying" };
    case "created":
    case "contacting":
      return { tone: "live", words: d.businesses ? `Contacting ${plural(d.businesses, "business", "businesses")}` : "Contacting businesses" };
    case "collecting":
      if (d.quotes && d.businesses) return { tone: "live", words: `${d.quotes} of ${d.businesses} quoted` };
      return { tone: "live", words: d.businesses ? `Waiting for ${plural(d.businesses, "reply", "replies")}` : "Waiting for replies" };
    case "negotiating":
      return { tone: "live", words: "Negotiating" };
    case "paid":
      return { tone: "ok", words: "Paid" };
    case "confirmed":
      return { tone: "ok", words: "Confirmed" };
    case "cancelled":
      return { tone: "idle", words: "Cancelled" };
    case "failed":
      return { tone: "risk", words: "Stopped" };
    default:
      return { tone: "live", words: stateWords(d.state) };
  }
}

/** The deal board's URL. */
export const dealHref = (jobId: string) => `/deals/${encodeURIComponent(jobId)}`;
