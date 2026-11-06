// Who may get a workspace (lib/waitlist/gate.ts): existing members always, otherwise only someone the
// operator admitted. A lookup that fails must never read as "admitted".
import { describe, expect, it } from "vitest";
import { admissionState, mayProvision, type AdmissionDeps } from "../lib/waitlist/gate.ts";

const user = { id: "u1", email: "Ada@Example.com" };

const deps = (over: Partial<AdmissionDeps> = {}): AdmissionDeps => ({
  isMember: async () => false,
  lookup: async () => null,
  ...over,
});

describe("admissionState", () => {
  it("an existing member is never checked against the waitlist", async () => {
    const r = await admissionState(user, deps({ isMember: async () => true, lookup: async () => { throw new Error("must not be called"); } }), false);
    expect(r).toBe("member");
  });

  it("someone the operator admitted", async () => {
    expect(await admissionState(user, deps({ lookup: async () => ({ admitted: true }) }), false)).toBe("admitted");
  });

  it("someone still waiting", async () => {
    expect(await admissionState(user, deps({ lookup: async () => ({ admitted: false }) }), false)).toBe("waiting");
  });

  it("someone not on the list", async () => {
    expect(await admissionState(user, deps(), false)).toBe("none");
  });

  it("looks the email up in lowercase, as it is stored", async () => {
    const seen: string[] = [];
    await admissionState(user, deps({ lookup: async (e) => (seen.push(e), null) }), false);
    expect(seen).toEqual(["ada@example.com"]);
  });

  it("a user with no email is not on the list", async () => {
    expect(await admissionState({ id: "u1" }, deps(), false)).toBe("none");
  });

  it("a demo site lets everyone through without touching the database", async () => {
    const boom = async () => { throw new Error("must not be called"); };
    expect(await admissionState(user, { isMember: boom, lookup: boom }, true)).toBe("admitted");
  });

  it("a failed lookup throws, so the caller can't provision", async () => {
    await expect(admissionState(user, deps({ lookup: async () => { throw new Error("database down"); } }), false)).rejects.toThrow("database down");
  });
});

describe("mayProvision", () => {
  it.each([["member", true], ["admitted", true], ["waiting", false], ["none", false]] as const)("%s -> %s", (state, allowed) => {
    expect(mayProvision(state)).toBe(allowed);
  });
});
