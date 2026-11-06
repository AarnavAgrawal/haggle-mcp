// The sign-in return (lib/auth/callback.ts): Google comes back with ?code=, an emailed link with
// ?token_hash=&type=. The operator's admit email is requested by a script, so it has no PKCE verifier in
// the person's browser and can only finish through the token_hash branch.
import { describe, expect, it } from "vitest";
import { finishSignIn, type CallbackAuth } from "../lib/auth/callback.ts";

function fake(over: Partial<CallbackAuth> = {}) {
  const calls: unknown[] = [];
  const auth: CallbackAuth = {
    exchangeCodeForSession: async (code) => (calls.push({ code }), { error: null }),
    verifyOtp: async (params) => (calls.push(params), { error: null }),
    ...over,
  };
  return { auth, calls };
}
const q = (s: string) => new URLSearchParams(s);

describe("finishSignIn", () => {
  it("exchanges a code", async () => {
    const { auth, calls } = fake();
    expect(await finishSignIn(q("code=abc"), auth)).toBe(true);
    expect(calls).toEqual([{ code: "abc" }]);
  });

  it("verifies an emailed link's token hash", async () => {
    const { auth, calls } = fake();
    expect(await finishSignIn(q("token_hash=h1&type=email"), auth)).toBe(true);
    expect(calls).toEqual([{ token_hash: "h1", type: "email" }]);
  });

  it("accepts the magiclink type", async () => {
    expect(await finishSignIn(q("token_hash=h1&type=magiclink"), fake().auth)).toBe(true);
  });

  it.each(["recovery", "email_change", "invite", "signup", ""])("refuses a link of type %j", async (type) => {
    const { auth, calls } = fake();
    expect(await finishSignIn(q(`token_hash=h1&type=${type}`), auth)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("fails when Supabase refuses", async () => {
    const { auth } = fake({ verifyOtp: async () => ({ error: { message: "expired" } }), exchangeCodeForSession: async () => ({ error: { message: "bad code" } }) });
    expect(await finishSignIn(q("token_hash=h1&type=email"), auth)).toBe(false);
    expect(await finishSignIn(q("code=abc"), auth)).toBe(false);
  });

  it("fails with nothing to finish", async () => {
    expect(await finishSignIn(q(""), fake().auth)).toBe(false);
  });
});
