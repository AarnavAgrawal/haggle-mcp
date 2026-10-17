// Signed-webhook safety at the engine edge, using the SDK's real signature check and trust logic.
// Cases follow quote-broker@8a68559 tests/webhook.test.ts (Partner); routing/DB parts stay with
// ingestion, which isn't built until the contracts freeze.
import { describe, expect, it } from "vitest";
import { signWebhookPayload } from "@primitivedotdev/sdk/webhook";
import { senderTrust, toInbound, verifyWebhook } from "../src/inbound/primitive.ts";
import { matchInbound } from "../src/inbound/matching.ts";
import { buildEvent } from "./helpers/primitiveEvent.ts";

const SECRET = "whsec_test_secret";
const now = () => Math.floor(Date.now() / 1000);
const signed = (body: string, secret = SECRET, t = now()) => new Headers({ "primitive-signature": signWebhookPayload(body, secret, t).header, "content-type": "application/json" });

describe("verifyWebhook", () => {
  it("accepts a correctly signed event for our endpoint", () => {
    const body = JSON.stringify(buildEvent({ endpointId: "ep_buyer" }));
    expect(verifyWebhook(body, signed(body), { secret: SECRET, endpointId: "ep_buyer" })).toMatchObject({ ok: true });
  });

  it("rejects a missing, wrong-secret, stale, or tampered signature", () => {
    const body = JSON.stringify(buildEvent());
    expect(verifyWebhook(body, new Headers(), { secret: SECRET })).toEqual({ ok: false, status: 401, reason: "invalid_signature" });
    expect(verifyWebhook(body, signed(body, "whsec_other"), { secret: SECRET })).toMatchObject({ ok: false });
    expect(verifyWebhook(body, signed(body, SECRET, now() - 3600), { secret: SECRET })).toMatchObject({ ok: false });
    const tampered = body.replace("We can do $22 per head.", "We can do $1 per head.");
    expect(verifyWebhook(tampered, signed(body), { secret: SECRET })).toMatchObject({ ok: false, reason: "invalid_signature" });
  });

  it("rejects an event delivered to another endpoint", () => {
    const body = JSON.stringify(buildEvent({ endpointId: "ep_seller" }));
    expect(verifyWebhook(body, signed(body), { secret: SECRET, endpointId: "ep_buyer" })).toEqual({ ok: false, status: 401, reason: "wrong_endpoint" });
  });
});

describe("toInbound", () => {
  it("parses From strictly and keeps the job inbox recipient", () => {
    const m = toInbound(buildEvent({ from: "Quotes@Bay-Catering.primitive.email", fromName: "Bay Catering" }));
    expect(m.from).toBe("quotes@bay-catering.primitive.email");
    expect(m.to).toContain("job-7f3k@brave-dog.primitive.email");
  });

  it("does not take an address planted in the display name", () => {
    const e = buildEvent({ from: "x@evil.test" });
    (e.email.headers as { from: string }).from = '"quotes@bay-catering.primitive.email" <x@evil.test>';
    expect(toInbound(e).from).toBe("x@evil.test");
  });
});

describe("senderTrust", () => {
  const bay = "quotes@bay-catering.primitive.email";

  it("trusts an authenticated email from the expected address", () => {
    expect(senderTrust(buildEvent({ from: bay }), bay)).toMatchObject({ trusted: true, reason: "trusted" });
  });

  it("does not trust failed authentication, another address, or another domain", () => {
    expect(senderTrust(buildEvent({ from: bay, auth: "fail" }), bay)).toMatchObject({ trusted: false });
    expect(senderTrust(buildEvent({ from: "sales@bay-catering.primitive.email" }), bay)).toMatchObject({ trusted: false, reason: "sender-mismatch" });
    expect(senderTrust(buildEvent({ from: "quotes@evil.test" }), bay)).toMatchObject({ trusted: false });
  });

  it("a display-name spoof is not the expected sender", () => {
    const e = buildEvent({ from: "x@evil.test" });
    (e.email.headers as { from: string }).from = `"${bay}" <x@evil.test>`;
    expect(senderTrust(e, bay).trusted).toBe(false);
  });
});

describe("webhook event -> matcher", () => {
  it("routes a first reply on the job inbox to the business it came from", () => {
    const m = toInbound(buildEvent({ from: "quotes@bay-catering.primitive.email" }));
    const r = matchInbound(
      { to: m.to, threadId: m.threadId, inReplyTo: m.inReplyTo, references: m.references, subject: m.subject, from: m.from ?? "" },
      [{ businessId: "b-bay", jobId: "job-1", shortCode: "7F3K", email: "quotes@bay-catering.primitive.email", threadId: null, outboundMessageId: null }],
      [],
      "brave-dog.primitive.email",
    );
    expect(r).toMatchObject({ kind: "business", businessId: "b-bay", jobId: "job-1" });
  });
});
