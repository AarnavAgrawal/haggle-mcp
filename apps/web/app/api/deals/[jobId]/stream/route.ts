// GET /api/deals/<jobId>/stream?cursor=<n>: live deal updates as server-sent events while the browser
// is connected (lib/dashboard/stream.ts has the protocol). Stops on a terminal state or after ~5
// minutes; the client reconnects with the last cursor.
import { apiHaggle } from "@/lib/dashboard/api";
import { isJobId } from "@/lib/dashboard/actions";
import { parseCursor, sseComment, streamUpdates } from "@/lib/dashboard/stream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const HEARTBEAT_MS = 15_000;

export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!isJobId(jobId)) return Response.json({ ok: false, error: { code: "bad_job_id", message: "That deal id isn't valid.", fix: "Open the deal from the deals list." } }, { status: 400 });
  const access = await apiHaggle();
  if ("response" in access) return access.response;
  const cursor = parseCursor(new URL(request.url).searchParams.get("cursor"));

  const stop = new AbortController();
  request.signal.addEventListener("abort", () => stop.abort(), { once: true });
  const enc = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (frame: string) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(frame));
        } catch {
          open = false;
          stop.abort();
        }
      };
      emit("retry: 3000\n\n");
      heartbeat = setInterval(() => emit(sseComment("heartbeat")), HEARTBEAT_MS);
      try {
        await streamUpdates(access.haggle, jobId, cursor, stop.signal, emit);
      } finally {
        clearInterval(heartbeat);
        open = false;
        try {
          controller.close();
        } catch {
          /* already closed by the client */
        }
      }
    },
    cancel() {
      clearInterval(heartbeat);
      stop.abort();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
