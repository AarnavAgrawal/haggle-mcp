// The Slack message for a new waitlist entry (optional: WAITLIST_SLACK_WEBHOOK_URL, a Slack-compatible
// incoming webhook). Everything in it was typed by a stranger, so it is escaped: unescaped, "<!channel>"
// would ping the whole channel and "<https://x|y>" would show a link that goes somewhere else.
import type { WaitlistRow } from "./schema.ts";

const plain = (s: string) => s.replace(/\s+/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function joinMessage(row: WaitlistRow): string {
  const email = plain(row.email);
  return [
    `New waitlist signup: *${plain(row.full_name)}* (${email}), ${plain(row.organization)}`,
    ...(row.use_case ? [`Use case: ${plain(row.use_case)}`] : []),
    `To let them in, tell Claude Code: let in ${email}`,
  ].join("\n");
}

/** Posts the message. Never throws: a Slack problem must not fail or slow a join. */
export async function postJoin(url: string | undefined, row: WaitlistRow, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!url) return;
  try {
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: joinMessage(row), unfurl_links: false, unfurl_media: false }), signal: AbortSignal.timeout(3000) });
    if (!res.ok) console.warn(JSON.stringify({ level: "warn", event: "waitlist_slack_failed", status: res.status }));
  } catch {
    console.warn(JSON.stringify({ level: "warn", event: "waitlist_slack_failed" }));
  }
}
