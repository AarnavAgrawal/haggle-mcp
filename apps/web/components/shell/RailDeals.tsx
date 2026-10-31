// The rail's deals list, streamed behind <Suspense> (the rail never waits for it). Grouped Needs you /
// In progress / Done; each row: request, status line, best price. Fails quietly with a retry.
import Link from "next/link";
import { Price } from "@/components/ui/Price";
import { Skeleton } from "@/components/ui/Skeleton";
import { Status } from "@/components/ui/Status";
import { loadDeals } from "./data";
import { dealHref, dealStatus, groupDeals } from "./deals";
import { RailLink } from "./RailLink";
import { RetryButton } from "./RetryButton";

/** Finished deals beyond this many are left to /deals. */
const DONE_SHOWN = 5;

export async function RailDeals() {
  const r = await loadDeals();
  if (r.error) {
    return (
      <div className="rail-note" role="status">
        <span>Couldn&rsquo;t load deals.</span>
        <RetryButton />
      </div>
    );
  }
  const groups = groupDeals(r.deals.deals);
  if (!groups.length) return <p className="rail-note">No deals yet.</p>;
  return (
    <>
      {groups.map((g) => {
        const shown = g.key === "done" ? g.deals.slice(0, DONE_SHOWN) : g.deals;
        const more = g.deals.length - shown.length;
        return (
          <div key={g.key} className={`rail-group rail-group-${g.key}`}>
            <h2 className="rail-group-label">{g.label}</h2>
            <ul className="rail-list">
              {shown.map((d) => {
                const s = dealStatus(d);
                return (
                  <li key={d.job_id}>
                    <RailLink href={dealHref(d.job_id)} match="prefix" className="rail-deal" label={d.what}>
                      <span className="rail-deal-meta">
                        <Status tone={s.tone}>{s.words}</Status>
                        {d.leading ? <Price amount={d.leading.total_usd} size="s" /> : null}
                      </span>
                    </RailLink>
                  </li>
                );
              })}
            </ul>
            {more > 0 ? (
              <Link className="rail-more" href="/deals">
                {more} more finished
              </Link>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

/** Shaped like three deal rows, shown while the list streams in. */
export function RailDealsSkeleton() {
  return (
    <div className="rail-group" aria-busy="true" aria-label="Loading deals">
      <Skeleton w={72} h={10} style={{ margin: "4px 8px 10px" }} />
      {[0, 1, 2].map((i) => (
        <div key={i} className="rail-skeleton-row">
          <Skeleton w={i === 1 ? "70%" : "88%"} h={12} />
          <Skeleton w={i === 2 ? "40%" : "55%"} h={10} />
        </div>
      ))}
    </div>
  );
}
