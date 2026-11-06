// POST /api/waitlist's logic, with the database, limits and Slack injected so it is testable without Next
// or Supabase (lib/waitlist/deps.ts wires the real ones). The one public write in this app, so:
//   - the answer is the same whether the email is new, already waiting or already admitted, so the form
//     can't be used to find out who is on the list;
//   - an existing entry is never changed, so nobody can rewrite someone else's details;
//   - nothing is ever emailed to the address given, so the form can't be used to mail a stranger.
// Junk entries cost nothing because admission is by hand; that's why this has limits and a honeypot, not a captcha.
import { createHash } from "node:crypto";
import { accountError, accountJson, sameOrigin } from "../account/request.ts";
import type { Limiter } from "../rateLimit.ts";
import { parseJoin, type WaitlistRow } from "./schema.ts";

export type { WaitlistRow };

export interface WaitlistDeps {
  /** Adds the entry unless the email is already there; true when a row was really added. */
  insert(row: WaitlistRow): Promise<boolean>;
  /** Per client address: 5 joins per 10 minutes. */
  ipLimiter: Limiter;
  /** Across the site: 500 joins per UTC day (key "site"). */
  dailyLimiter: Limiter;
  /** Tells the operator (Slack). Never throws. */
  announce(row: WaitlistRow): Promise<void>;
  /** Runs a task after the response, so its timing can't tell a new email from a known one. */
  defer(task: () => Promise<void>): void;
}

const JOINED = { ok: true, next: "You're on the list. We'll email you when you're in." };

/** A hash of the client's address (the host sets these headers): the raw address is never stored. */
function clientKey(req: Request): string {
  const ip = req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return createHash("sha256").update(ip).digest("hex");
}

export async function handleJoin(req: Request, deps: WaitlistDeps): Promise<Response> {
  if (!sameOrigin(req) || !req.headers.get("content-type")?.includes("application/json")) {
    return accountError(403, "cross_site", "This request must come from Haggle's own waitlist page.", "Use the form on /waitlist.");
  }
  if (!(await deps.ipLimiter.take(clientKey(req))).ok) return accountError(429, "rate_limited", "Too many attempts.", "Wait a few minutes, then try again.");

  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (raw === null || typeof raw !== "object") return accountError(400, "bad_body", "The request body isn't JSON.", "Send a JSON body.");
  if (raw.website) return accountJson(200, JOINED); // the hidden field only a bot fills in

  const parsed = parseJoin(raw);
  if (!parsed.ok) {
    const [field, message] = Object.entries(parsed.errors)[0]!;
    return accountJson(400, { ok: false, error: { code: "invalid", field, message, fix: "Correct this field, then try again." } });
  }
  if (!(await deps.dailyLimiter.take("site")).ok) return accountError(429, "busy", "The waitlist is busy right now.", "Try again tomorrow.");

  let created: boolean;
  try {
    created = await deps.insert(parsed.row);
  } catch {
    return accountError(500, "unavailable", "We couldn't add you to the list.", "Try again in a moment.");
  }
  if (created) deps.defer(() => deps.announce(parsed.row));
  return accountJson(200, JOINED);
}
