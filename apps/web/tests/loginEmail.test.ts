// Username + password sign-in: what someone types becomes the Supabase account's email.
import { describe, expect, it } from "vitest";
import { loginEmail, USERNAME_DOMAIN } from "../lib/loginEmail";

describe("loginEmail", () => {
  it("a username signs in as <username>@users.tryhaggle.tech (case and spaces ignored)", () => {
    expect(USERNAME_DOMAIN).toBe("users.tryhaggle.tech");
    expect(loginEmail("ycombinator")).toBe("ycombinator@users.tryhaggle.tech");
    expect(loginEmail("  YCombinator ")).toBe("ycombinator@users.tryhaggle.tech");
    expect(loginEmail("dana.ops-2")).toBe("dana.ops-2@users.tryhaggle.tech");
  });

  it("an email is used as is", () => {
    expect(loginEmail("Priya@Acme.com")).toBe("priya@acme.com");
  });

  it("anything else is refused before calling Supabase", () => {
    for (const bad of ["", " ", "a", "no spaces allowed", "bad@", "@x.com", "x@y", "-dash", "semi;colon"]) expect(loginEmail(bad)).toBeNull();
  });
});
