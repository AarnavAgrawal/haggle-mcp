// Vendor categories (migration 127): a deal contacts a workspace's vendors only for the kind of work they
// do. A vendor's kind is its stored category, else what its name says; unknown never matches by default.
import { describe, expect, it } from "vitest";
import { InMemoryRepository, HaggleEngine, StubBrain, disabledPayer, vendorCategoryName } from "@haggle/engine";
import { knownCategory, servesCategory, vendorCategory } from "../src/businesses.ts";
import { categoryInput } from "../src/service/vendors.ts";
import { workspaceVendorList } from "../src/vendors.ts";

describe("vendor categories", () => {
  it("a phrase names a category only when it clearly says one", () => {
    expect(knownCategory("Bay Area Plumbing")).toBe("plumbing");
    expect(knownCategory("plumber")).toBe("plumbing");
    expect(knownCategory("Casa Catering")).toBe("catering");
    expect(knownCategory("handyman repairs and electrical")).toBe("electrical");
    expect(knownCategory("Acme Services")).toBeNull();
    expect(knownCategory("plumbing")).toBe("plumbing");
  });

  it("a vendor's stored category wins over its name; with neither it is unknown", () => {
    expect(vendorCategory({ name: "Bay Plumbing", category: "catering" })).toBe("catering");
    expect(vendorCategory({ name: "Bay Plumbing" })).toBe("plumbing");
    expect(vendorCategory({ name: "Acme Services", category: null })).toBeNull();
    expect(vendorCategory({ name: "Acme Services", added_by: "web:user-1" })).toBeNull();
    // Added by the operator before categories (the pilot's catering scope): catering.
    expect(vendorCategory({ name: "Harbor Table", added_by: "operator:workspace-admin" })).toBe("catering");
  });

  it("a vendor serves its own kind; a general repair business also takes plumbing and electrical; unknown serves nothing", () => {
    expect(servesCategory("plumbing", "plumbing")).toBe(true);
    expect(servesCategory("catering", "plumbing")).toBe(false);
    expect(servesCategory("repairs", "plumbing")).toBe(true);
    expect(servesCategory("plumbing", "repairs")).toBe(false);
    expect(servesCategory(null, "plumbing")).toBe(false);
  });

  it("input from the web: a search or a typed kind becomes a stored category; empty clears it", () => {
    expect(categoryInput("plumber")).toBe("plumbing");
    expect(categoryInput("Landscaping!")).toBe("landscaping");
    expect(categoryInput("  ")).toBeNull();
    expect(categoryInput(null)).toBeNull();
    expect(vendorCategoryName("Lawn care")).toBe("lawn care");
    expect(vendorCategoryName("42")).toBeNull();
  });

  it("the merged vendor list keeps a vendor's category", () => {
    expect(workspaceVendorList([{ name: "Drain Pros", contact: "a@b.test", category: "plumbing" }, { name: "Drain Pros", contact: "+14155550161" }])).toEqual([
      { name: "Drain Pros", business_ref: "drain_pros", email: "a@b.test", phone: "+14155550161", category: "plumbing", channel: "email" },
    ]);
  });

  it("the engine stores, changes and clears it; an unreadable one is refused", async () => {
    const repo = new InMemoryRepository();
    const engine = new HaggleEngine({
      repo, extractor: { async extract() { throw new Error("unused"); } } as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
      email: { async send() { throw new Error("unused"); } },
      config: { mode: "mock", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 60_000, negotiationWindowMs: 60_000, approvalTtlMs: 60_000, globalPaymentCapCents: 500_000 },
    } as never);
    await repo.insertWorkspace({ id: "ws_a", name: "a", token_hash: null, connector_secret_hash: null, timezone: "America/Los_Angeles" });
    const row = await engine.addWorkspaceVendor({ workspace_id: "ws_a", contact: "Jobs@DrainPros.test", name: "Drain Pros", consent: "existing_relationship", added_by: "web:u", category: "Plumbing" });
    expect(row.category).toBe("plumbing");
    expect(await engine.setWorkspaceVendorCategory("ws_a", "jobs@drainpros.test", "repairs")).toBe(true);
    expect((await engine.workspaceVendors("ws_a"))[0]!.category).toBe("repairs");
    expect(await engine.setWorkspaceVendorCategory("ws_a", "jobs@drainpros.test", null)).toBe(true);
    expect((await engine.workspaceVendors("ws_a"))[0]!.category).toBeNull();
    expect(await engine.setWorkspaceVendorCategory("ws_a", "nobody@x.test", "plumbing")).toBe(false);
    await expect(engine.setWorkspaceVendorCategory("ws_a", "jobs@drainpros.test", "123")).rejects.toMatchObject({ code: "bad_category" });
  });
});
