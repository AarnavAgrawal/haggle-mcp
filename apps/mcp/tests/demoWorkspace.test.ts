// Demo workspaces on a live server (HAGGLE_DEMO_WORKSPACES): a demo login never finds businesses and its
// vendors can't be added, removed or recategorised from the app, so it can never email a real business.
import { afterEach, describe, expect, it } from "vitest";
import type { FoundBusiness, ListingProvider } from "@haggle/engine";
import { DiscoveryRegistry } from "../src/businesses.ts";
import { findForDeal } from "../src/dealDiscovery.ts";
import { DEMO_WORKSPACE_REASON, demoWorkspaceIds, isDemoWorkspace } from "../src/demoWorkspace.ts";
import type { Runtime } from "../src/runtime.ts";
import { addVendorChecked, type VendorEngine } from "../src/service/vendors.ts";

const prior = process.env.HAGGLE_DEMO_WORKSPACES;
afterEach(() => {
  if (prior === undefined) delete process.env.HAGGLE_DEMO_WORKSPACES;
  else process.env.HAGGLE_DEMO_WORKSPACES = prior;
});

describe("demo workspaces", () => {
  it("parses the comma-separated list; unset means none", () => {
    expect([...demoWorkspaceIds({ HAGGLE_DEMO_WORKSPACES: " ws_demo , ws_two,," })]).toEqual(["ws_demo", "ws_two"]);
    expect(demoWorkspaceIds({}).size).toBe(0);
    expect(isDemoWorkspace("ws_demo", { HAGGLE_DEMO_WORKSPACES: "ws_demo" })).toBe(true);
    expect(isDemoWorkspace("ws_real", { HAGGLE_DEMO_WORKSPACES: "ws_demo" })).toBe(false);
    expect(isDemoWorkspace(null, { HAGGLE_DEMO_WORKSPACES: "ws_demo" })).toBe(false);
  });

  it("deal never searches listings for a demo workspace", async () => {
    let searched = false;
    const listing: ListingProvider = {
      kind: "google", source: "Google Places", attribution: "Google Maps", owns: () => true, details: async () => null,
      discover: async () => { searched = true; return [{ business_ref: "place:x", name: "Real Plumber", listing_emails: ["real@plumber.example"] } as unknown as FoundBusiness]; },
    };
    const rt = { mode: "live", listing, channels: async () => ({ email: true }) } as unknown as Runtime;
    const r = await findForDeal({ rt, registry: new DiscoveryRegistry(), category: "plumbing", area: "Oakland, CA", existing: new Set(), reserved: new Set(), suppressed: async () => new Set(), limit: 6, demoWorkspace: true });
    expect(r).toMatchObject({ status: "off", candidates: [], reason: DEMO_WORKSPACE_REASON });
    expect(searched).toBe(false);
  });

  it("the app can't add a vendor to a demo workspace (nothing is stored)", async () => {
    process.env.HAGGLE_DEMO_WORKSPACES = "ws_demo";
    let stored = 0;
    const engine = { addWorkspaceVendor: async () => { stored++; return {} as never; } } as unknown as VendorEngine;
    const r = await addVendorChecked({ engine, mode: "live" }, "ws_demo", { name: "Real Caterer", contact: "orders@real.example", consent_basis: "existing_relationship" } as never, { attestedBy: "web:u", now: new Date() });
    expect(r).toMatchObject({ ok: false, status: 403, code: "DEMO_WORKSPACE" });
    expect(stored).toBe(0);
  });
});
