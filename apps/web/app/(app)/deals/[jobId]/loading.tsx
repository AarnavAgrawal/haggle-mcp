// The deal board's instant skeleton: header, the quote sheet's rows and the side column, in place.
import { Skeleton, SkeletonText } from "@/components/ui/Skeleton";
import "@/components/dashboard/board.css";

export default function Loading() {
  return (
    <main className="shell board" aria-busy="true" aria-label="Loading the deal">
      <header className="board-head">
        <Skeleton w={72} h={14} style={{ margin: "9px 0" }} />
        <Skeleton w="min(420px, 80%)" h={36} />
        <Skeleton w="min(360px, 70%)" h={14} style={{ marginTop: 6 }} />
        <Skeleton w={160} h={14} style={{ marginTop: 4 }} />
      </header>
      <div className="board-grid">
        <div className="board-main">
          <div className="sheet">
            <div className="sheet-head">
              <Skeleton w={84} h={22} />
            </div>
            {[0, 1, 2].map((i) => (
              <div key={i} className="sk-row">
                <Skeleton w={20} h={20} radius={999} />
                <span className="sk-stack">
                  <Skeleton w={i === 1 ? "46%" : "38%"} h={16} />
                  <Skeleton w={i === 2 ? "52%" : "64%"} h={12} />
                </span>
                <span className="sk-stack" style={{ justifyItems: "end" }}>
                  <Skeleton w={84} h={24} />
                  <Skeleton w={96} h={12} />
                </span>
              </div>
            ))}
          </div>
          <div className="activity">
            <Skeleton w={88} h={18} />
            <SkeletonText lines={3} lineHeight={14} gap={18} />
          </div>
        </div>
        <div className="board-aside">
          <div className="sk-stack">
            <Skeleton w={72} h={14} />
            <SkeletonText lines={4} lineHeight={12} gap={12} />
          </div>
          <div className="sk-stack">
            <Skeleton w={88} h={14} />
            <SkeletonText lines={3} lineHeight={12} gap={12} />
          </div>
        </div>
      </div>
    </main>
  );
}
