// Refused sign-ins (lib/auth/callback.ts): someone with no account goes to the waitlist, whichever way they tried.
import { describe, expect, it } from "vitest";
import { refusedNewAccount, refusedSignup } from "../lib/auth/callback.ts";

describe("refusedNewAccount", () => {
  it("spots Supabase refusing a new account, so Google sign-in can go to the waitlist", () => {
    expect(refusedNewAccount(new URLSearchParams("error=access_denied&error_code=signup_disabled"))).toBe(true);
    expect(refusedNewAccount(new URLSearchParams("error=server_error"))).toBe(false);
    expect(refusedNewAccount(new URLSearchParams("code=abc"))).toBe(false);
  });

  it("goes by Supabase's wording too, in case its error code changes", () => {
    expect(refusedNewAccount(new URLSearchParams("error=server_error&error_description=Signups+not+allowed+for+this+instance"))).toBe(true);
    expect(refusedNewAccount(new URLSearchParams("error=server_error&error_description=Something+else"))).toBe(false);
  });
});

describe("refusedSignup", () => {
  it.each(["Signups not allowed for otp", "Signup not allowed", "Signups not allowed for this instance"])("reads %j as no account for that email", (message) => {
    expect(refusedSignup(message)).toBe(true);
  });

  it.each(["Email rate limit exceeded", "captcha verification process failed", ""])("leaves %j as an ordinary error", (message) => {
    expect(refusedSignup(message)).toBe(false);
  });
});
