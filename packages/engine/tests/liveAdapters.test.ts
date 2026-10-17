// Live adapters' safety rules, with fakes (no network).
import { describe, expect, it } from "vitest";
import { isPrimitiveHost, parseFleet, primitiveAttachments, x402Payer } from "../src/live/adapters.ts";
import type { MessageRow } from "../src/store/types.ts";

const msg = (url: string | null): MessageRow => ({
  id: "m", job_id: "j", business_id: "b", approval_id: null, direction: "in", kind: "reply", provider_email_id: "e", idempotency_key: null, rfc_message_id: null,
  thread_id: null, from_address: null, to_address: null, subject: null, body_text: null, attachments: [{ filename: "q.pdf", content_type: "application/pdf", size_bytes: 1, tar_path: "parts/q.pdf" }],
  attachments_download_url: url, sender_trusted: true, trust_reason: null, matched_via: null, parse_status: "pending", quarantine_reason: null, round: null, simulated: false, channel: "email", created_at: "",
});

describe("live adapters", () => {
  it("only sends the API key to Primitive's own https hosts", async () => {
    expect(isPrimitiveHost("https://api.primitive.dev/v1/x")).toBe(true);
    expect(isPrimitiveHost("https://primitive.dev.evil.test/x")).toBe(false);
    expect(isPrimitiveHost("http://api.primitive.dev/x")).toBe(false);
    let called = false;
    const fetchSpy = (async () => { called = true; return new Response("", { status: 500 }); }) as typeof fetch;
    await expect(primitiveAttachments("prim_x", fetchSpy).load(msg("https://evil.test/a.tar.gz"))).rejects.toThrow(/not on Primitive/);
    expect(called).toBe(false);
  });

  it("parses the demo fleet spec", () => {
    expect(parseFleet("Bay Catering <Quotes@Bay.primitive.email>; bad entry; Harbor <h@x.test>")).toEqual([
      { name: "Bay Catering", email: "quotes@bay.primitive.email" }, { name: "Harbor", email: "h@x.test" },
    ]);
  });

  it("a missing or malformed payer key yields no signer (payments are refused, never faked)", () => {
    expect(x402Payer({ apiKey: "prim_x", privateKey: undefined })).toMatchObject({ signer: null, simulated: false });
    expect(x402Payer({ apiKey: "prim_x", privateKey: "0x123" }).signer).toBeNull();
    const ok = x402Payer({ apiKey: "prim_x", privateKey: `0x${"11".repeat(32)}` });
    expect((ok.signer as { address: string }).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
