// Integration (sprint 2026-10-22): the text webhook carries the line it arrived on, and the engine
// refuses a text addressed to a number that isn't this server's line (text_routes are per line).
import { describe, expect, it } from "vitest";
import { inkboxTextReceived } from "../src/live/inkbox.ts";

describe("text.received mapping", () => {
  it("passes Haggle's own number (local_phone_number) as `to`", () => {
    const m = inkboxTextReceived({ data: { text_message: { id: "t1", direction: "inbound", local_phone_number: "+14155550100", remote_phone_number: "+1 (415) 555-0101", text: "YES 1234" } } });
    expect(m).toEqual({ messageId: "t1", from: "+14155550101", text: "YES 1234", inbound: true, to: "+14155550100" });
  });
  it("omits `to` when the payload has no local number", () => {
    expect(inkboxTextReceived({ data: { text_message: { id: "t2", direction: "inbound", remote_phone_number: "+14155550101", text: "hi" } } })).not.toHaveProperty("to");
  });
});
