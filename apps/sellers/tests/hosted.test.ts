// The seller fleet hosted inside another server (src/hosted.ts, mounted by the MCP server at
// /webhooks/sellers/<handle>): each webhook is verified with that seller's own key, answered later
// through the same ports, and the registry from HAGGLE_SELLERS_JSON keeps only verifiable sellers.
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SellerPorts } from "../src/app.ts";
import { templateReply } from "../src/compose.ts";
import { createHostedSellers, demoCallTranscript, parseSellerRegistry } from "../src/hosted.ts";

const KEY = "whsec_harbortest";
const RFQ = "Hi! We need lunch for our 40-person offsite on Thursday, Oct 22 in SF. At least 12 vegetarian meals, delivered by 11:45. Budget under $1,200.";
const signed = (body: string, secret = KEY) => {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", secret.replace(/^whsec_/, "")).update(`req_1.${ts}.${body}`).digest("hex");
  return { "x-inkbox-signature": `sha256=${sig}`, "x-inkbox-request-id": "req_1", "x-inkbox-timestamp": ts };
};

function setup() {
  const sent: { handle: string; body: string; files?: string[] }[] = [];
  const ports: SellerPorts = {
    replyEmail: async (handle, a) => void sent.push({ handle, body: a.bodyText, files: a.attachments.map((x) => x.filename) }),
    getEmailBody: async () => RFQ,
    getA2ATask: async () => ({ contextId: "c", text: RFQ }),
    replyA2A: async () => undefined,
  };
  const sellers = createHostedSellers({
    inkboxApiKey: "unused", registry: { "harbor-table-sf": { identityId: "id_h", email: "harbor-table-sf@inkboxmail.com", signingKey: KEY } },
    ports, composer: { write: async (p, plan) => templateReply(p, plan) }, delayMs: () => 0, log: () => undefined,
  });
  return { sellers, sent };
}

const event = JSON.stringify({ id: "evt_1", event_type: "message.received", data: { message: { id: "m1", thread_id: "t1", direction: "inbound", from_address: "ws-demo@inkboxmail.com", subject: "Catering request" } } });

describe("hosted sellers", () => {
  it("a signed email to a seller is acknowledged at once and answered by that seller", async () => {
    const { sellers, sent } = setup();
    expect(sellers.webhook("harbor-table-sf", Buffer.from(event), signed(event))).toEqual({ status: 202, body: "" });
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 });
    expect(sent).toEqual([expect.objectContaining({ handle: "harbor-table-sf" })]);
    expect(sent[0]!.body.length).toBeGreaterThan(20); // a quote or, with its drawn terms, a polite decline
  });

  it("refuses an unknown seller, a bad signature (another seller's key) and invalid JSON; nothing is sent", async () => {
    const { sellers, sent } = setup();
    expect(sellers.webhook("bay-catering-sf", Buffer.from(event), signed(event)).status).toBe(404);
    expect(sellers.webhook("harbor-table-sf", Buffer.from(event), signed(event, "whsec_other")).status).toBe(401);
    expect(sellers.webhook("harbor-table-sf", Buffer.from(event), {}).status).toBe(401);
    expect(sellers.webhook("harbor-table-sf", Buffer.from("not json"), signed("not json")).status).toBe(400);
    await sellers.idle();
    expect(sent).toEqual([]);
  });

  it("the registry keeps only sellers with a signing key and a safe handle", () => {
    const r = parseSellerRegistry(JSON.stringify({ "harbor-table-sf": { email: "h@inkboxmail.com", signingKey: KEY }, "no-key": { email: "x@inkboxmail.com" }, "../bad": { signingKey: KEY } }));
    expect(Object.keys(r)).toEqual(["harbor-table-sf"]);
    expect(() => parseSellerRegistry("{oops")).toThrow();
  });

  it("a played demo call quotes Mission Eats' real price for the headcount, counters and confirms by the brief, and the assistant says it's an AI", () => {
    const quote = demoCallTranscript("You are an AI assistant calling Mission Eats on behalf of Acme to request a price quote. Ask Mission Eats for a quote for: lunch catering for 30 people, 8 vegetarian.");
    expect(quote).toMatch(/\$810 total/); // $27 x 30
    expect(quote).toMatch(/haggle \(AI assistant\): Hi, I'm an AI assistant/);
    const counter = demoCallTranscript("Mission Eats quoted $810.00 total for lunch catering for 30 people. ... ask whether they can match or beat it.");
    expect(counter).toMatch(/\$769\.50 total/); // $25.65 x 30 (5% off)
    expect(demoCallTranscript("Tell Mission Eats the customer would like to go ahead with their quote for lunch for 30. Ask them to confirm.")).toMatch(/got you down/);
  });
});
