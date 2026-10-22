// Sprint 4 B: the operator's pilot onboarding, end to end over the same code the scripts run
// (planWorkspace + createWorkspace, planAdmin + runAdmin) against the in-memory store. `show` is a
// readiness check: approver, cap, ≥1 consented vendor, no suppressed vendor, active credentials.
// No database, no network.
import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "@haggle/engine";
import { createWorkspace, planWorkspace } from "../scripts/workspace-create.ts";
import { planAdmin, readiness, runAdmin, showData } from "../scripts/workspace-admin.ts";
import { hashSecret } from "../src/workspace.ts";

const admin = (repo: InMemoryRepository, ...argv: string[]) => runAdmin(planAdmin(argv), repo);

describe("pilot onboarding (operator)", () => {
  it("create prints the credentials and client details once; show fails until the workspace is ready, then passes", async () => {
    const repo = new InMemoryRepository();
    const plan = planWorkspace({ name: "Bay Events Co", approverPhone: "+14155550123", capUsd: 2500, area: "San Francisco, CA", timezone: "America/Los_Angeles", baseUrl: "https://haggle.example" });
    const out = await createWorkspace(plan, repo);
    expect(out).toContain(`Bearer token:   ${plan.token}`);
    expect(out).toContain(`claude mcp add --transport http haggle https://haggle.example/mcp --header "Authorization: Bearer ${plan.token}"`);
    expect(out).toMatch(/Connector URL:  https:\/\/haggle\.example\/c\/hgc_[A-Za-z0-9_-]{32}\/mcp/);
    expect(out).toMatch(/Readiness: FAIL \(4\/5 checks\)/);
    expect(out).toMatch(/\[FAIL\] vendors: none.*Fix: workspace-admin\.ts add-vendor --id ws_bay_events_co/);
    // Only hashes are stored.
    expect((await repo.getWorkspace("ws_bay_events_co"))!.token_hash).toBe(hashSecret(plan.token));
    await expect(createWorkspace(plan, repo)).rejects.toThrow(/already exists/);

    // Three consented vendors (email, email, text).
    await admin(repo, "add-vendor", "--id", "ws_bay_events_co", "--contact", "events@harbortable.example", "--name", "Harbor Table", "--consent", "Maria (owner) agreed by phone 2026-10-20");
    await admin(repo, "add-vendor", "--id", "ws_bay_events_co", "--contact", "orders@goldengrill.example", "--name", "Golden Grill", "--consent", "Sam agreed by email 2026-10-21");
    const added = await admin(repo, "add-vendor", "--id", "ws_bay_events_co", "--contact", "+14155550177", "--name", "Sunset Kitchen", "--consent", "Dev agreed in person 2026-10-21", "--channel", "text");
    expect(added.text).toMatch(/Sunset Kitchen <\+14155550177> authorized by text.*deal\(businesses=\['Sunset Kitchen'\]\)/);
    let show = await admin(repo, "show", "--id", "ws_bay_events_co");
    expect(show.failed).toBe(false);
    expect(show.text).toMatch(/Readiness: PASS \(5\/5 checks\)/);
    expect(show.text).not.toContain(plan.token);
    expect(show.text).not.toContain(hashSecret(plan.token));

    // A suppressed vendor (opted out / bounced) fails it, with the fix.
    await repo.addSuppression({ contact: "orders@goldengrill.example", reason: "opt_out", job_id: null, evidence: "STOP" });
    show = await admin(repo, "show", "--id", "ws_bay_events_co");
    expect(show.failed).toBe(true);
    expect(show.text).toMatch(/\[FAIL\] suppressions: Golden Grill opted out or bounced/);
    await admin(repo, "remove-vendor", "--id", "ws_bay_events_co", "--contact", "orders@goldengrill.example");
    expect((await admin(repo, "show", "--id", "ws_bay_events_co")).failed).toBe(false);

    // Revoked credentials fail it; rotate issues new ones (printed once) and passes again.
    await admin(repo, "revoke", "--id", "ws_bay_events_co");
    expect(readiness(await showData(repo, "ws_bay_events_co")).checks.find((c) => c.name === "credentials")).toMatchObject({ pass: false, fix: expect.stringMatching(/rotate/) });
    const rotated = await admin(repo, "rotate", "--id", "ws_bay_events_co", "--base-url", "https://haggle.example");
    const token = /Bearer token:\s+(hgw_\S+)/.exec(rotated.text)![1]!;
    expect(token).not.toBe(plan.token);
    expect((await repo.getWorkspace("ws_bay_events_co"))!.token_hash).toBe(hashSecret(token));
    expect((await admin(repo, "show", "--id", "ws_bay_events_co")).failed).toBe(false);
  });

  it("no approver phone, or no settings, fails with the exact command", async () => {
    const repo = new InMemoryRepository();
    const plan = planWorkspace({ name: "No Approver", baseUrl: "https://haggle.example" });
    const out = await createWorkspace(plan, repo);
    expect(out).toMatch(/\[FAIL\] approver: no approver phone.*set-approver --id ws_no_approver --phone/);
    await admin(repo, "set-approver", "--id", "ws_no_approver", "--phone", "+14155550199");
    await admin(repo, "add-vendor", "--id", "ws_no_approver", "--contact", "a@vendor.example", "--name", "A", "--consent", "agreed by phone");
    expect((await admin(repo, "show", "--id", "ws_no_approver")).text).toMatch(/Readiness: PASS/);
  });
});
