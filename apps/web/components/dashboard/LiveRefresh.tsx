"use client";
// Keeps a deal page live: an EventSource on /api/deals/<jobId>/stream; each update re-renders the page
// on the server (router.refresh() in a transition: the current board stays on screen, no flash, until
// the new one is ready), reconnecting with the last cursor. Updates that arrive close together are
// coalesced into one refresh. Visible only when something is wrong (reconnecting); otherwise a polite
// screen-reader status.
import { startTransition, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { backoffMs, cursorOf, streamUrl } from "@/lib/dashboard/live";

type Status = "connecting" | "live" | "reconnecting" | "done";
const LABEL: Record<Status, string> = { connecting: "Connecting to live updates", live: "Live updates on", reconnecting: "Reconnecting…", done: "Up to date" };
/** Coalesce a burst of updates (a quote and its state change) into one server render. */
const COALESCE_MS = 150;

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
      refreshTimer = setTimeout(() => startTransition(() => router.refresh()), COALESCE_MS);
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
        const wasDown = failures > 0;
        cursor = cursorOf((e as MessageEvent<string>).data) ?? cursor;
        failures = 0;
        setStatus("live");
        if (wasDown) refresh(); // catch up on anything missed while disconnected
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
      <span className={status === "reconnecting" ? "live-words" : "sr-only"}>{LABEL[status]}</span>
    </span>
  );
}
