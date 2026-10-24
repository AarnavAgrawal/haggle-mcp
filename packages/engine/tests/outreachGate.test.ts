// Pilot outreach gate: on a live server, a workspace with its own (operator-added) vendors contacts
// nobody until the operator has verified its approver phone (workspace-admin verify-approver). Before
// this, a pilot workspace whose approver nobody had confirmed still emailed real vendors for quotes
// that no verified human could approve; only the preflight script noticed. Fake ports, no network.
import { describe, expect, it } from "vitest";
import { CORPUS_REQUEST } from "../eval/corpus.ts";
import { makeEnv } from "../eval/harness.ts";
import { recordOperatorAction } from "../src/ops/operator.ts";

const WS = "ws_pilot";
const APPROVER = "+14155550123";
const VENDOR = { name: "Harbor Table", email: "events@harbortable.example" };
const noReader = { extract: async () => { throw new Error("no reply is read in this test"); } };

async function pilot() {
  const env = await makeEnv({ extractor: noReader, workspaces: [{ id: WS, approver: APPROVER }] });
  await env.repo.addWorkspaceVendor({ workspace_id: WS, contact: VENDOR.email, name: VENDOR.name, consent: "Maria (owner) agreed by phone", added_by: "ops", channel: "email" });
  const deal = () => env.engine.deal({ workspace_id: WS, request: CORPUS_REQUEST.request, budget_usd: CORPUS_REQUEST.budget_usd, businesses: [VENDOR] });
  const verify = (phone: string) => recordOperatorAction(env.repo, { action: "approver_verified", operator: "ops", reason: "read back on a call", workspaceId: WS, detail: { phone } });
  return { env, deal, verify };
}

describe("live pilot workspace: no vendor is contacted before the approver is verified", () => {
  it("refuses the deal with what the operator must do, sends nothing and starts no job; passes once verified", async () => {
    const { env, deal, verify } = await pilot();
    try {
      await expect(deal()).rejects.toMatchObject({ code: "approver_unverified", message: expect.stringMatching(/Nothing was sent/), fix: expect.stringMatching(/verify-approver --id ws_pilot/) });
      expect(await env.engine.outreachBlock(WS)).toMatchObject({ code: "approver_unverified" });
      expect(env.emails).toHaveLength(0);
      expect(await env.repo.listOpenJobs()).toHaveLength(0);

      // Verifying another number doesn't count.
      await verify("+14155550999");
      await expect(deal()).rejects.toMatchObject({ code: "approver_unverified" });

      await verify(APPROVER);
      expect(await env.engine.outreachBlock(WS)).toBeNull();
      const d = await deal();
      expect(d.job_id).toBeTruthy();
      expect(env.emails.map((e) => e.to)).toEqual([VENDOR.email]);
    } finally { env.restore(); }
  });

  it("an approver change needs a new verification; no approver phone is refused as approver_missing", async () => {
    const { env, deal, verify } = await pilot();
    try {
      await verify(APPROVER);
      await recordOperatorAction(env.repo, { action: "approver_changed", operator: "ops", reason: "new phone", workspaceId: WS, detail: { phone: "+14155550124" } });
      await env.engine.updateSettings({ approver_phone: "+14155550124" }, WS);
      await expect(deal()).rejects.toMatchObject({ code: "approver_unverified" });
      await env.engine.updateSettings({ approver_phone: null }, WS);
      await expect(deal()).rejects.toMatchObject({ code: "approver_missing", fix: expect.stringMatching(/set-approver --id ws_pilot/) });
      expect(env.emails).toHaveLength(0);
    } finally { env.restore(); }
  });

  it("mock mode, the single-tenant default workspace and live workspaces without their own roster are unchanged", async () => {
    const env = await makeEnv({ extractor: noReader, config: { mode: "mock" }, workspaces: [{ id: WS, approver: APPROVER }] });
    try {
      await env.repo.addWorkspaceVendor({ workspace_id: WS, contact: VENDOR.email, name: VENDOR.name, consent: "agreed", added_by: "ops", channel: "email" });
      expect(await env.engine.outreachBlock(WS)).toBeNull();
    } finally { env.restore(); }
    const live = await makeEnv({ extractor: noReader, workspaces: [{ id: "ws_other", approver: "+14155550125" }] });
    try {
      expect(await live.engine.outreachBlock("ws_other")).toBeNull();
      await live.repo.addWorkspaceVendor({ workspace_id: "ws_default", contact: VENDOR.email, name: VENDOR.name, consent: "agreed", added_by: "ops", channel: "email" });
      expect(await live.engine.outreachBlock("ws_default")).toBeNull();
    } finally { live.restore(); }
  });
});
