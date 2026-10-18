// PURE: why an iMessage to a business failed, in words the human can act on. Inkbox puts a stable
// error code in the response body (e.g. `imessage_awaiting_inbound`); the message text carries it.

export function imessageFailureReason(error: string, handle: string): string {
  const code = /"error"\s*:\s*"([a-z_]+)"/.exec(error)?.[1] ?? /\b(imessage_[a-z_]+)\b/.exec(error)?.[1] ?? null;
  const status = Number(/HTTP (\d{3})/.exec(error)?.[1] ?? (error.match(/\b(4\d\d|5\d\d)\b/)?.[1] ?? 0));
  switch (code) {
    case "imessage_awaiting_inbound":
      return "connected, but they haven't texted the agent's iMessage line yet: they must send it one message (to the line Inkbox assigned, not the router) before Haggle can text first";
    case "imessage_connection_expired":
      return `their iMessage connection expired: they must text "connect @${handle}" to the router number again`;
    case "imessage_unanswered_followup_limit":
      return "Inkbox's limit of 3 unanswered texts is reached: wait for their reply";
    case "imessage_opening_message_too_long":
    case "imessage_reply_required_for_phone_numbers":
    case "imessage_reply_required_for_links_or_media":
      return `the text broke Inkbox's first-message rules (${code}); nothing was sent`;
  }
  if (status === 404) return `not connected: they must text "connect @${handle}" to the Inkbox router number first`;
  if (status === 403) return "blocked by an Inkbox contact rule on the buyer identity";
  if (status === 409) return `iMessage connection not ready${code ? ` (${code})` : ""}`;
  return `iMessage send failed${status ? ` (Inkbox ${status})` : ""}`;
}
