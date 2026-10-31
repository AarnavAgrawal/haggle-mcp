// A conversation while it loads: the title bar, a few turns, and the composer pinned to the bottom.
import { Skeleton, SkeletonText } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <main className="chat-layout" aria-busy="true" aria-label="Loading">
      <div className="chat-main">
        <div className="chat-head">
          <div className="chat-col chat-head-row">
            <Skeleton w={280} h={18} />
          </div>
        </div>
        <div className="chat-log" aria-hidden="true">
          <div className="chat-col chat-thread">
            <Skeleton className="chat-skel-user" w="46%" h={44} radius={8} />
            <SkeletonText lines={3} lineHeight={14} gap={12} className="chat-skel-text" />
            <Skeleton w="100%" h={180} radius={8} />
            <Skeleton className="chat-skel-user" w="22%" h={44} radius={8} />
          </div>
        </div>
        <div className="chat-form">
          <div className="chat-col">
            <div className="composer composer-skeleton" aria-hidden="true" />
          </div>
        </div>
      </div>
    </main>
  );
}
