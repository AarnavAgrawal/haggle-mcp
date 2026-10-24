// Reconciler catch-up after restarts and long outages (sprint 4, workstream F). The inbound sweep
// normally looks back a few hours (InboundReconciler maxLookbackMs, 6 h): a server down for two days
// would never list what arrived in between, and a lost webhook from then would stay lost. Each
// channel keeps a durable high-water mark (reconcile_cursors, migration 117): the time up to which
// every item was listed and handled. A full sweep first catches up from the mark in bounded slices,
// oldest first, then sweeps its normal window; the mark moves only over a range swept cleanly (no
// listing or ingest error, nothing left to retry, the listing not cut at its page limit). Ingest is
// idempotent by provider id, so re-listing an overlap never double-ingests.

export interface CatchUpParams {
  /** Re-list this much before the mark (items can be listed slightly after their createdAt). */
  overlapMs: number;
  /** Never catch up further back than this; older gaps are logged for an operator (reconcile_gap). */
  maxCatchUpMs: number;
  /** A catch-up slice (one listing per channel); halved down to minSliceMs while a listing is cut at its limit. */
  sliceMs: number;
  minSliceMs: number;
  /** Slices per channel per sweep (bounds the work one sweep does after a long outage). */
  maxSlicesPerSweep: number;
}

export const CATCH_UP: CatchUpParams = {
  overlapMs: 10 * 60_000,
  maxCatchUpMs: 14 * 86_400_000,
  sliceMs: 6 * 3_600_000,
  minSliceMs: 5 * 60_000,
  maxSlicesPerSweep: 8,
};

/**
 * The range still to catch up for one channel: from its mark (less the overlap, never before
 * maxCatchUpMs ago) to where the normal window starts. Null when the normal window already covers it
 * (the steady state) or the channel has no mark yet (first run: the normal window, then a mark).
 * `clamped`: the mark is older than maxCatchUpMs, so part of the gap is never swept automatically.
 */
export function catchUpRange(i: { highWater: string | null; recentSince: number; nowMs: number }, p: CatchUpParams = CATCH_UP): { from: number; to: number; clamped: boolean } | null {
  if (!i.highWater || !Number.isFinite(Date.parse(i.highWater))) return null;
  const mark = Date.parse(i.highWater) - p.overlapMs;
  const floor = i.nowMs - p.maxCatchUpMs;
  const from = Math.max(mark, floor);
  if (from >= i.recentSince) return null;
  return { from, to: i.recentSince, clamped: mark < floor };
}

/** How one listing of one range went. */
export interface RangeSweep { clean: boolean; truncated: boolean }

/**
 * Walk a catch-up range oldest first: sweep a slice, move the mark to its end when clean, halve the
 * slice while a listing is cut at its page limit, stop at the first unclean slice (the next sweep
 * retries from the mark) or after maxSlicesPerSweep listings. Returns how far it got.
 */
export async function walkCatchUp(range: { from: number; to: number }, sweepRange: (from: number, to: number) => Promise<RangeSweep>, advance: (to: number) => Promise<void>, p: CatchUpParams = CATCH_UP): Promise<{ reached: number; complete: boolean; listings: number; stuck: "truncated" | "error" | null }> {
  let from = range.from;
  let slice = p.sliceMs;
  let listings = 0;
  while (from < range.to && listings < p.maxSlicesPerSweep) {
    listings++;
    const to = Math.min(from + slice, range.to);
    const r = await sweepRange(from, to);
    if (r.truncated) {
      if (slice > p.minSliceMs) {
        slice = Math.max(p.minSliceMs, Math.floor(slice / 2));
        continue;
      }
      return { reached: from, complete: false, listings, stuck: "truncated" };
    }
    if (!r.clean) return { reached: from, complete: false, listings, stuck: "error" };
    await advance(to);
    from = to;
    slice = Math.min(p.sliceMs, slice * 2); // past the burst: back toward full slices
  }
  return { reached: from, complete: from >= range.to, listings, stuck: null };
}
