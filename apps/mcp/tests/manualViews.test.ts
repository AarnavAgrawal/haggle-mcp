// P4 (item 7), MCP layer: what the server tells the views about the manual payment handoff. The board's
// payments_enabled comes from the engine's paymentsEnabled (true on the manual rail, where the engine's
// board read model says false), web_app says whether the Haggle web app can record the human's steps,
// the approval card learns the rail before any payment row exists (payment_rail), and the pending
// "approve by text" wording mentions the web app only when it is on. Mock servers opt in with
// HAGGLE_PAYMENTS=manual (DEMO).
import { describe, expect, it } from "vitest";
import approvalFixture from "../../../fixtures/views/approval.json" with { type: "json" };
import { webAppOn } from "../src/service/approvals.ts";
import { ApprovalOut, DealBoardPlus, pendingByTextNext } from "../src/views.ts";
import { ENV_MANIFEST } from "../src/envManifest.ts";

const TOKEN = "t".repeat(32);

describe("web app reach", () => {
  it("is on only with a service token (32+ chars) and HAGGLE_WEB_APPROVALS not turned off", () => {
    expect(webAppOn({ HAGGLE_SERVICE_TOKEN: TOKEN })).toBe(true);
    expect(webAppOn({ HAGGLE_SERVICE_TOKEN: TOKEN, HAGGLE_WEB_APPROVALS: "true" })).toBe(true);
    expect(webAppOn({ HAGGLE_SERVICE_TOKEN: TOKEN, HAGGLE_WEB_APPROVALS: "false" })).toBe(false);
    expect(webAppOn({ HAGGLE_SERVICE_TOKEN: TOKEN, HAGGLE_WEB_APPROVALS: "off" })).toBe(false);
    expect(webAppOn({ HAGGLE_SERVICE_TOKEN: "short" })).toBe(false);
    expect(webAppOn({})).toBe(false);
  });

  it("the pending text-approval hint adds the web app only when it is on, and never carries a code", () => {
    expect(pendingByTextNext(false)).toBe("Sent to the approver's phone: they approve by replying YES <code> to Haggle's text.");
    expect(pendingByTextNext(true)).toBe("Sent to the approver's phone: they approve by replying YES <code> to Haggle's text, or approve it in the Haggle web app.");
  });
});

describe("schemas carry the manual rail to the views", () => {
  it("DealBoardPlus keeps web_app and payments_enabled", () => {
    const b = DealBoardPlus.parse({ job: null, empty: true, businesses: [], quotes: [], open_questions: [], next: "x", payments_enabled: true, web_app: true });
    expect(b).toMatchObject({ payments_enabled: true, web_app: true });
  });

  it("ApprovalOut keeps payment_rail and the payment row's rail and reason", () => {
    const a = ApprovalOut.parse({ ...approvalFixture, payment_rail: "manual", payment: { status: "instructions_received", simulated: false, rail: "manual", reason: "Bay confirmed the booking." } });
    expect(a.payment_rail).toBe("manual");
    expect(a.payment).toMatchObject({ rail: "manual", reason: "Bay confirmed the booking." });
  });
});

describe("mock opt-in", () => {
  it("HAGGLE_PAYMENTS is optional in mock (rehearses the handoff, DEMO) and still validated", () => {
    const spec = ENV_MANIFEST.find((s) => s.name === "HAGGLE_PAYMENTS")!;
    expect(spec.need.mock).toBe("optional");
    expect(spec.rule).toEqual({ kind: "enum", values: ["manual"] });
  });
});
