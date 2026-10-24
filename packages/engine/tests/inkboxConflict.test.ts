// Sprint 4 integration (S4-F finding): an Inkbox 409 idempotency conflict means an earlier attempt
// under the same key may have been accepted. It must map to an ambiguous failure (never re-sent,
// never treated as a bounce), not to a permanent "invalid address".
import { describe, expect, it } from "vitest";
import { InkboxAPIError } from "@inkbox/sdk";
import { mapInkboxError } from "../src/live/inkbox.ts";

describe("mapInkboxError: idempotency conflicts are ambiguous", () => {
  it("409 → ambiguous provider_error, not retryable, not invalid_address", () => {
    const e = Object.assign(Object.create(InkboxAPIError.prototype), { statusCode: 409, message: "idempotency key reused with different input", detail: { error: "idempotency_conflict" } });
    const m = mapInkboxError(e);
    expect(m).toMatchObject({ reason: "provider_error", retryable: false, ambiguous: true });
  });
  it("a 404 is still a bad address; a 5xx still retryable", () => {
    expect(mapInkboxError({ statusCode: 404, message: "no such mailbox" })).toMatchObject({ reason: "invalid_address", ambiguous: false });
    expect(mapInkboxError({ statusCode: 503, message: "busy" })).toMatchObject({ retryable: true });
  });
});
