// GET /live and GET /live/:jobId: the read-only demo page (DESIGN.md §2.3 S2).
//
// Off unless LIVE_PAGE_TOKEN is set. Then /live needs ?token=<value> (admin),
// and /live/:jobId takes either that token or the job's signed ?sig= link,
// which the tools give each user for their own jobs (see links.ts).
// The page only reads. Nothing here can approve, pay, or send email.
// Add ?fragment=1 for just the refreshing part (used by the page script).
import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { secretMatches } from "../auth.js";
import { ConfigError } from "../config.js";
import {
  getApprovalsForJob,
  getCurrentQuotes,
  getJob,
  getMessagesForJob,
  getPaymentsForJob,
  getVendors,
  listRecentJobs,
} from "../db/queries.js";
import { verifyJobLink } from "./links.js";
import { renderIndex, renderJobFragment, renderPage } from "./render.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function html(c: Context, body: string, status: 200 | 404 | 503, nonce?: string): Response {
  const csp = nonce
    ? `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    : "default-src 'none'; frame-ancestors 'none'";
  return c.html(body, status, {
    "Content-Security-Policy": csp,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
  });
}

export async function handleLive(c: Context): Promise<Response> {
  const token = process.env.LIVE_PAGE_TOKEN;
  const jobId = c.req.param("jobId");
  // Two ways in: the admin token (index + any job), or a job's own signed link
  // (that job only). Same 404 for disabled, wrong, or missing: don't advertise it.
  const admin = Boolean(token) && secretMatches(c.req.query("token"), token);
  const signed = Boolean(jobId) && verifyJobLink(jobId!, c.req.query("sig"), token);
  if (!token || !(admin || signed)) return html(c, "Not found", 404);

  const fragmentOnly = c.req.query("fragment") === "1";
  const credential = admin ? `token=${encodeURIComponent(token)}` : `sig=${encodeURIComponent(c.req.query("sig")!)}`;
  const self = `${c.req.path}?${credential}&fragment=1`;

  try {
    let title: string;
    let body: string;
    if (!jobId) {
      title = "Quote Broker · Jobs";
      body = renderIndex(await listRecentJobs(20), token);
    } else {
      const job = UUID.test(jobId) ? await getJob(jobId) : null;
      if (!job) return html(c, "Not found", 404);
      const [vendors, quotes, messages, approvals, payments] = await Promise.all([
        getVendors(jobId),
        getCurrentQuotes(jobId),
        getMessagesForJob(jobId),
        getApprovalsForJob(jobId),
        getPaymentsForJob(jobId),
      ]);
      title = `QB-${job.short_code} · Quote Broker`;
      body = renderJobFragment({ job, vendors, quotes, messages, approvals, payments });
    }
    if (fragmentOnly) return html(c, body, 200);
    const nonce = randomBytes(16).toString("base64");
    return html(c, renderPage({ title, body, nonce, refreshUrl: self }), 200, nonce);
  } catch (err) {
    if (err instanceof ConfigError) return html(c, "Server not configured", 503);
    console.error("[live] render failed:", err instanceof Error ? err.message : err);
    return html(c, "Temporarily unavailable", 503);
  }
}
