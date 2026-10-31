// /deals' instant skeleton: the title, then a group of deal rows shaped like the real list.
import { Skeleton } from "@/components/ui/Skeleton";
import "@/components/dashboard/board.css";

export default function Loading() {
  return (
    <main className="shell deals-page" aria-busy="true" aria-label="Loading deals">
      <header className="page-head">
        <Skeleton w={120} h={36} />
        <Skeleton w={148} h={40} />
      </header>
      <div className="deals-groups">
        <section>
          <Skeleton w={96} h={14} style={{ marginBottom: 12 }} />
          <div className="deals-list">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="sk-deal">
                <span className="sk-stack">
                  <Skeleton w={i % 2 ? "62%" : "48%"} h={16} />
                  <Skeleton w="40%" h={12} />
                </span>
                <span className="sk-stack">
                  <Skeleton w="70%" h={14} />
                  <Skeleton w="45%" h={12} />
                </span>
                <span className="sk-stack" style={{ justifyItems: "end" }}>
                  <Skeleton w={64} h={16} />
                  <Skeleton w={80} h={12} />
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
