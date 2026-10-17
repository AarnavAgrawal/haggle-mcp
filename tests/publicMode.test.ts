// Public mode (AUTH_MODE=oauth): who the caller is, which jobs they can touch,
// per-user idempotency ids, the demo-vendor allowlist, signed live links, and
// the sign-in page's handling of untrusted values.
import { describe, expect, it } from "vitest";
import { callerFromContext, canAccess, OPERATOR, scopedClientRequestId } from "../src/caller.js";
import { notAllowed, parseDemoVendors } from "../src/vendors/demoVendors.js";
import { signJobLink, verifyJobLink } from "../src/live/links.js";
import { renderConsentPage } from "../src/oauth/consent.js";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ctxFor = (id: string, email?: string) => ({ auth: { user: { id, email } } });

describe("callerFromContext", () => {
  it("is always the operator in token mode, whatever the context says", () => {
    expect(callerFromContext(ctxFor(ALICE, "a@x.com"), "token")).toEqual(OPERATOR);
  });

  it("reads the verified user in oauth mode and lowercases the email", () => {
    expect(callerFromContext(ctxFor(ALICE, " Alice@Example.COM "), "oauth")).toEqual({ userId: ALICE, email: "alice@example.com" });
  });

  it("refuses a request with no verified user in oauth mode (never falls back to the operator)", () => {
    expect(() => callerFromContext({}, "oauth")).toThrow();
    expect(() => callerFromContext({ auth: { user: { id: "" } } }, "oauth")).toThrow();
    expect(() => callerFromContext(undefined, "oauth")).toThrow();
  });

  it("allows a user without an email (approval will ask them to fix it)", () => {
    expect(callerFromContext(ctxFor(ALICE), "oauth")).toEqual({ userId: ALICE, email: null });
  });
});

describe("canAccess", () => {
  const alice = { userId: ALICE, email: "a@x.com" };
  it("lets a user see only their own jobs", () => {
    expect(canAccess({ owner_id: ALICE }, alice)).toBe(true);
    expect(canAccess({ owner_id: BOB }, alice)).toBe(false);
  });

  it("keeps operator jobs (no owner) away from signed-in users, and vice versa", () => {
    expect(canAccess({ owner_id: null }, alice)).toBe(false);
    expect(canAccess({ owner_id: ALICE }, OPERATOR)).toBe(false);
    expect(canAccess({ owner_id: null }, OPERATOR)).toBe(true);
  });
});

describe("scopedClientRequestId", () => {
  it("gives two users with the same id different keys", () => {
    const a = scopedClientRequestId({ userId: ALICE, email: null }, "party-1");
    const b = scopedClientRequestId({ userId: BOB, email: null }, "party-1");
    expect(a).not.toBe(b);
  });

  it("leaves the operator's ids unchanged (existing jobs keep matching)", () => {
    expect(scopedClientRequestId(OPERATOR, "party-1")).toBe("party-1");
  });
});

describe("demo vendor allowlist", () => {
  const raw = "Budget Bites <catering@pink-crab.primitive.email>; Taqueria Sol <Catering@Vast-Llama.primitive.email> ; junk";
  const list = parseDemoVendors(raw);

  it("parses Name <email> entries and skips malformed ones", () => {
    expect(list).toEqual([
      { name: "Budget Bites", email: "catering@pink-crab.primitive.email" },
      { name: "Taqueria Sol", email: "catering@vast-llama.primitive.email" },
    ]);
  });

  it("rejects any vendor not on the list, case-insensitively accepting listed ones", () => {
    expect(notAllowed(["CATERING@pink-crab.primitive.email"], list)).toEqual([]);
    expect(notAllowed(["orders@real-restaurant.com", "catering@pink-crab.primitive.email"], list)).toEqual(["orders@real-restaurant.com"]);
  });

  it("is empty when unset", () => {
    expect(parseDemoVendors(undefined)).toEqual([]);
  });
});

describe("signed live links", () => {
  const secret = "live-secret-for-tests-123";
  it("opens exactly the job it was signed for", () => {
    const sig = signJobLink("job-a", secret);
    expect(verifyJobLink("job-a", sig, secret)).toBe(true);
    expect(verifyJobLink("job-b", sig, secret)).toBe(false);
  });

  it("rejects missing, wrong, or unconfigured signatures", () => {
    expect(verifyJobLink("job-a", undefined, secret)).toBe(false);
    expect(verifyJobLink("job-a", "x".repeat(32), secret)).toBe(false);
    expect(verifyJobLink("job-a", signJobLink("job-a", secret), undefined)).toBe(false);
    expect(verifyJobLink("job-a", signJobLink("job-a", "other-secret"), secret)).toBe(false);
  });
});

describe("sign-in page", () => {
  it("can't be broken out of by values in its inline config", () => {
    const html = renderConsentPage(
      { supabaseUrl: "https://x.supabase.co", publishableKey: "pk", loginMethods: ["github"], brokerAddress: "</script><script>alert(1)</script>" },
      "n0nce",
    );
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain('<script nonce="n0nce" src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js" integrity="sha384-');
  });
});
