"use client";
// Keeps a deal page live: an EventSource on /api/deals/<jobId>/stream, router.refresh() (debounced) on
// each update, reconnecting with the last cursor. Shows a small Live / Reconnecting indicator.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { backoffMs, cursorOf, streamUrl } from "@/lib/dashboard/live";

type Status = "connecting" | "live" | "reconnecting" | "done";
const LABEL: Record<Status, string> = { connecting: "Connecting", live: "Live", reconnecting: "Reconnecting", done: "Up to date" };

export function LiveRefresh({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("connecting");

  useEffect(() => {
    let es: EventSource | null = null;
    let cursor: string | null = null;
    let failures = 0;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    const refresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => router.refresh(), 400);
    };
    const reconnect = (delay: number) => {
      es?.close();
      es = null;
      if (closed) return;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, delay);
    };
    function connect() {
      if (closed) return;
      const src = new EventSource(streamUrl(jobId, cursor));
      es = src;
      src.addEventListener("ready", (e) => {
        cursor = cursorOf((e as MessageEvent<string>).data) ?? cursor;
        failures = 0;
        setStatus("live");
      });
      src.addEventListener("update", (e) => {
        cursor = cursorOf((e as MessageEvent<string>).data) ?? cursor;
        refresh();
      });
      src.addEventListener("end", (e) => {
        const data = (e as MessageEvent<string>).data;
        cursor = cursorOf(data) ?? cursor;
        let reason = "";
        try {
          reason = String((JSON.parse(data) as { reason?: unknown }).reason ?? "");
        } catch {
          /* keep going */
        }
        if (reason === "terminal") {
          src.close();
          es = null;
          setStatus("done");
          refresh();
        } else {
          reconnect(0); // the ~5 minute limit: pick up where it left off
        }
      });
      src.addEventListener("problem", () => setStatus("reconnecting"));
      src.onerror = () => {
        // The browser would retry on its own with the original URL (no cursor); retry ourselves instead.
        if (es === src) {
          failures += 1;
          setStatus("reconnecting");
          reconnect(backoffMs(failures));
        }
      };
    }

    connect();
    return () => {
      closed = true;
      clearTimeout(retryTimer);
      clearTimeout(refreshTimer);
      es?.close();
    };
  }, [jobId, router]);

  return (
    <span className={`live live-${status}`} role="status" aria-live="polite">
      <span className="live-dot" aria-hidden="true" />
      {LABEL[status]}
    </span>
  );
}
