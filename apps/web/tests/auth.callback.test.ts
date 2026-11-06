// Finishing an emailed sign-in link (lib/auth/callback.ts). The operator's admit email is requested by a
// script, so it has no PKCE verifier in the person's browser and can only finish through a token_hash.
import { describe, expect, it } from "vitest";
import { confirmEmailLink, refusedNewAccount, type EmailLinkAuth } from "../lib/auth/callback.ts";

function fake(over: Partial<EmailLinkAuth> = {}) {
  const calls: unknown[] = [];
  const auth: EmailLinkAuth = { verifyOtp: async (params) => (calls.push(params), { error: null }), ...over };
  return { auth, calls };
}

describe("confirmEmailLink", () => {
  it("verifies an emailed link's token hash", async () => {
    const { auth, calls } = fake();
    expect(await confirmEmailLink({ token_hash: "h1", type: "email" }, auth)).toBe(true);
    expect(calls).toEqual([{ token_hash: "h1", type: "email" }]);
  });

  it("accepts the magiclink type", async () => {
    expect(await confirmEmailLink({ token_hash: "h1", type: "magiclink" }, fake().auth)).toBe(true);
  });

  it.each(["recovery", "email_change", "invite", "signup", "", null])("refuses a link of type %j", async (type) => {
    const { auth, calls } = fake();
    expect(await confirmEmailLink({ token_hash: "h1", type }, auth)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("fails when Supabase refuses", async () => {
    expect(await confirmEmailLink({ token_hash: "h1", type: "email" }, fake({ verifyOtp: async () => ({ error: { message: "expired" } }) }).auth)).toBe(false);
  });

  it("fails with no token", async () => {
    expect(await confirmEmailLink({ token_hash: null, type: "email" }, fake().auth)).toBe(false);
  });
});

describe("refusedNewAccount", () => {
  it("spots Supabase refusing a new account, so Google sign-in can go to the waitlist", () => {
    expect(refusedNewAccount(new URLSearchParams("error=access_denied&error_code=signup_disabled"))).toBe(true);
    expect(refusedNewAccount(new URLSearchParams("error=server_error"))).toBe(false);
    expect(refusedNewAccount(new URLSearchParams("code=abc"))).toBe(false);
  });
});
