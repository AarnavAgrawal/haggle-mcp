// A business conversation's instant skeleton: the name, then transcript entries.
import { Skeleton, SkeletonText } from "@/components/ui/Skeleton";
import "@/components/dashboard/board.css";

export default function Loading() {
  return (
    <main className="shell board" aria-busy="true" aria-label="Loading the conversation">
      <Skeleton w={120} h={14} style={{ margin: "9px 0" }} />
      <header className="convo-head">
        <Skeleton w="min(300px, 70%)" h={36} />
        <Skeleton w={180} h={14} style={{ marginTop: 6 }} />
      </header>
      <div className="convo">
        <ol className="thread" aria-hidden="true">
          {[3, 4, 2].map((lines, i) => (
            <li key={i} className="msg">
              <Skeleton w={18} h={18} />
              <span className="sk-stack">
                <Skeleton w={i === 1 ? "44%" : "32%"} h={14} />
                <SkeletonText lines={lines} lineHeight={12} gap={10} />
              </span>
            </li>
          ))}
        </ol>
      </div>
    </main>
  );
}
