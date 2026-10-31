// The instant loading state for every signed-in route (the shell stays; this fills the content area).
// Routes with a distinct shape add their own loading.tsx.
import { Skeleton, SkeletonText } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <main className="shell app-loading" aria-busy="true" aria-label="Loading">
      <div className="app-loading-head">
        <Skeleton w={260} h={30} />
        <Skeleton w={120} h={40} />
      </div>
      <div className="ui-sheet ui-sheet-pad-none app-loading-rows">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="app-loading-row">
            <SkeletonText lines={2} lineHeight={12} />
            <Skeleton w={72} h={16} />
          </div>
        ))}
      </div>
    </main>
  );
}
