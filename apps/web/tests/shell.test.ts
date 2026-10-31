// The app shell's deals list (components/shell/deals.ts): grouping list_deals rows into Needs you /
// In progress / Done, and the one status line each row shows (tone + plain words).
import { describe, expect, it } from "vitest";
import { dealHref, dealStatus, groupDeals } from "../components/shell/deals.ts";
import type { DealRow } from "../lib/dashboard/types.ts";

const row = (state: string, extra: Partial<DealRow> = {}): DealRow => ({ job_id: `job_${state}`, what: `Lunch (${state})`, state, ...extra });

describe("groupDeals", () => {
  it("puts deals waiting on the human first, then active ones, then finished ones, keeping server order", () => {
    const rows = [row("collecting"), row("paid"), row("awaiting_approval"), row("contacting"), row("cancelled"), row("paying"), row("negotiating", { job_id: "n2" })];
    const g = groupDeals(rows);
    expect(g.map((x) => x.key)).toEqual(["needs_you", "in_progress", "done"]);
    expect(g[0]!.label).toBe("Needs you");
    expect(g[0]!.deals.map((d) => d.state)).toEqual(["awaiting_approval", "paying"]);
    expect(g[1]!.deals.map((d) => d.state)).toEqual(["collecting", "contacting", "negotiating"]);
    expect(g[2]!.deals.map((d) => d.state)).toEqual(["paid", "cancelled"]);
  });

  it("leaves out empty groups", () => {
    expect(groupDeals([row("paid")]).map((x) => x.key)).toEqual(["done"]);
    expect(groupDeals([])).toEqual([]);
  });
});

describe("dealStatus", () => {
  it("says what is happening in the buyer's words", () => {
    expect(dealStatus(row("awaiting_approval"))).toEqual({ tone: "hold", words: "Needs your approval" });
    expect(dealStatus(row("contacting", { businesses: 4 }))).toEqual({ tone: "live", words: "Contacting 4 businesses" });
    expect(dealStatus(row("created"))).toEqual({ tone: "live", words: "Contacting businesses" });
    expect(dealStatus(row("collecting", { businesses: 5, quotes: 0 }))).toEqual({ tone: "live", words: "Waiting for 5 replies" });
    expect(dealStatus(row("collecting", { businesses: 5, quotes: 2 }))).toEqual({ tone: "live", words: "2 of 5 quoted" });
    expect(dealStatus(row("collecting"))).toEqual({ tone: "live", words: "Waiting for replies" });
    expect(dealStatus(row("negotiating"))).toEqual({ tone: "live", words: "Negotiating" });
    expect(dealStatus(row("paid"))).toEqual({ tone: "ok", words: "Paid" });
    expect(dealStatus(row("confirmed"))).toEqual({ tone: "ok", words: "Confirmed" });
    expect(dealStatus(row("cancelled"))).toEqual({ tone: "idle", words: "Cancelled" });
    expect(dealStatus(row("failed"))).toEqual({ tone: "risk", words: "Stopped" });
  });

  it("uses one reply/business in the singular", () => {
    expect(dealStatus(row("collecting", { businesses: 1, quotes: 0 })).words).toBe("Waiting for 1 reply");
    expect(dealStatus(row("contacting", { businesses: 1 })).words).toBe("Contacting 1 business");
  });

  it("never shows a raw state code", () => {
    expect(dealStatus(row("some_new_state")).words).toBe("some new state");
  });
});

describe("dealHref", () => {
  it("links to the deal board, encoding the id", () => {
    expect(dealHref("job_a/b")).toBe("/deals/job_a%2Fb");
  });
});
