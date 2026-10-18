// iMessage send failures → the exact reason and fix (Inkbox error codes from the live API).
import { describe, expect, it } from "vitest";
import { imessageFailureReason } from "../src/outbound/imessageErrors.ts";

describe("imessageFailureReason", () => {
  it("maps each Inkbox code to an actionable reason", () => {
    expect(imessageFailureReason('HTTP 409: {"error":"imessage_awaiting_inbound","address":"+1…"}', "haggle")).toMatch(/^connected, but they haven't texted the agent's iMessage line yet/);
    expect(imessageFailureReason('HTTP 409: {"error":"imessage_connection_expired"}', "haggle")).toBe('their iMessage connection expired: they must text "connect @haggle" to the router number again');
    expect(imessageFailureReason('HTTP 429: {"error":"imessage_unanswered_followup_limit"}', "haggle")).toMatch(/limit of 3 unanswered texts/);
    expect(imessageFailureReason('HTTP 422: {"error":"imessage_reply_required_for_links_or_media"}', "haggle")).toMatch(/first-message rules .*nothing was sent/);
  });
  it("falls back on the HTTP status, never guessing a cause it can't see", () => {
    expect(imessageFailureReason("HTTP 404: not found", "haggle")).toBe('not connected: they must text "connect @haggle" to the Inkbox router number first');
    expect(imessageFailureReason("HTTP 403: rejected", "haggle")).toBe("blocked by an Inkbox contact rule on the buyer identity");
    expect(imessageFailureReason("HTTP 500: boom", "haggle")).toBe("iMessage send failed (Inkbox 500)");
    expect(imessageFailureReason("socket hang up", "haggle")).toBe("iMessage send failed");
  });
});
