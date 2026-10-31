// The new-request page while it loads: the heading, the composer and the examples, in place.
import { Skeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <main className="chat-layout" data-empty aria-busy="true" aria-label="Loading">
      <div className="chat-main">
        <div className="chat-intro chat-col">
          <Skeleton w={360} h={34} />
          <Skeleton w={420} h={16} style={{ marginTop: 14 }} />
        </div>
        <div className="chat-form">
          <div className="chat-col">
            <div className="composer composer-skeleton" aria-hidden="true" />
          </div>
        </div>
        <div className="chat-start chat-col" aria-hidden="true">
          <Skeleton w={72} h={14} />
          <div className="chat-skel-rows">
            {[0, 1, 2].map((i) => (
              <div key={i} className="chat-skel-row">
                <Skeleton w={96} h={14} />
                <Skeleton w={i === 1 ? "62%" : "78%"} h={14} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
