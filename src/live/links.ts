// Per-job live page links. The tools hand the agent a link like
// /live/<job_id>?sig=<hmac> so the human can watch their own job without the
// admin LIVE_PAGE_TOKEN. The signature covers the job id only, so a link opens
// exactly one job, and nobody can forge one without the server's secret.
import { createHmac, timingSafeEqual } from "node:crypto";

export function signJobLink(jobId: string, secret: string): string {
  return createHmac("sha256", `live-link:${secret}`).update(jobId).digest("base64url").slice(0, 32);
}

export function verifyJobLink(jobId: string, sig: string | undefined, secret: string | undefined): boolean {
  if (!secret || !sig) return false;
  const want = Buffer.from(signJobLink(jobId, secret));
  const given = Buffer.from(sig);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Full URL for a job's live page, or null when the live page is disabled. */
export function liveUrlFor(jobId: string): string | null {
  const secret = process.env.LIVE_PAGE_TOKEN;
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (!secret || !base) return null;
  return `${base}/live/${encodeURIComponent(jobId)}?sig=${signJobLink(jobId, secret)}`;
}
