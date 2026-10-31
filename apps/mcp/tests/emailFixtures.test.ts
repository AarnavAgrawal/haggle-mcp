// Replayable real-world-format vendor email (packages/engine/tests/fixtures-email/*.json) through the
// real inbound pipeline: a signed Inkbox webhook into src/webhook.ts handleInkboxWebhook, the engine's
// matching and reply-token verification, and the next advance's parse (scripts/email-trial-replay.ts).
// Each fixture states what must become of it: an appropriately trusted quote, or a quarantine.
// Also: Inkbox payloads typed with the installed SDK's own wire and detail types. No network.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MailWebhookPayload, MessageDetail } from "@inkbox/sdk";
import { addressedToBuyer, inkboxToInbound, type ExtractorPort, type InkboxMessageDetail } from "@haggle/engine";
import { fillPlaceholders, replayPipeline } from "../scripts/email-trial-replay.ts";

const DIR = join(import.meta.dirname, "../../../packages/engine/tests/fixtures-email");
const BUYER = "haggle@inkboxmail.test";
const VENDOR = { name: "Valley Catering", email: "orders@valley.example" };
const OTHER = { name: "Westside Kitchen", email: "hello@westside.example" };

type Fixture = {
  name: string; client: string; notes: string; detail: InkboxMessageDetail; event: { agent_identities: { bucket: string; address: string }[] };
  files?: Record<string, { text?: string; base64?: string }>; deal?: "other_deal"; deliver_times?: number;
  expect: { outcome: string; stored_as?: string; sender_trusted?: boolean; trust_reason?: string | null; quarantine_reason?: string | null; quote_total_usd: number | null };
};
const fixtures: Fixture[] = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")));

/** A Claude stand-in: the total from the business's own words (already cut by the engine) or its PDF text. */
const reader: ExtractorPort = {
  async extract(i) {
    const hay = [i.bodyText, ...i.pdfs.map((p) => Buffer.from(p.data).toString("latin1"))].join("\n");
    const money = (re: RegExp) => { const m = hay.match(re); const g = m?.slice(1).find((x) => x !== undefined); return g ? Number(g.replace(/,/g, "")) : null; };
    const total = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*(?:total|all[ -]in)/i);
    const deposit = money(/(?:deposit\s*\$\s?([\d,]+))|(?:\$\s?([\d,]+)\s*deposit)/i);
    const src = i.pdfs.length && !/\$\s?[\d,]+\s*(?:total|all)/i.test(i.bodyText) ? "pdf" : "email body";
    return {
      available: true, price_per_head_usd: null, headcount: 40, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true,
      total_usd: total, deposit_usd: deposit, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }], valid_until: null, questions: [],
      payment_request: "none", instructions_to_agent: false, sources: total !== null ? [{ field: "total", source: src, excerpt: `$${total} total` }] : [], missing_fields: total === null ? ["total"] : [], confidence: 0.9,
    } as never;
  },
};

async function pipeline() {
  const p = await replayPipeline({ buyer: BUYER, vendors: [VENDOR, OTHER], extractor: reader });
  const [dealA, dealB] = p.deals;
  const v = dealA!.find((d) => d.business.email === VENDOR.email)!;
  const o = dealA!.find((d) => d.business.email === OTHER.email)!;
  const job = (await p.repo.getJob(v.jobId))!;
  const map = {
    BUYER, VENDOR: VENDOR.email, TOKEN: v.token, RFQ_MESSAGE_ID: v.rfqMessageId, RFQ_SUBJECT: p.mailbox.sent.find((s) => s.to[0] === VENDOR.email)!.subject,
    OTHER_VENDOR: OTHER.email, OTHER_TOKEN: o.token, OTHER_RFQ_MESSAGE_ID: o.rfqMessageId, OTHER_DEAL_RFQ_MESSAGE_ID: dealB![0]!.rfqMessageId, OTHER_DEAL_TOKEN: dealB![0]!.token,
    SHORT_CODE: job.short_code, WHAT: job.request.what, AREA: job.request.area,
  };
  return { p, map, v, dealB: dealB![0]! };
}

const filesOf = (f: Fixture) => Object.fromEntries(Object.entries(f.files ?? {}).map(([k, x]) => [k, x.base64 ? new Uint8Array(Buffer.from(x.base64, "base64")) : new TextEncoder().encode(x.text ?? "")]));

describe("fixtures-email: real client layouts and adversarial mail through the webhook", () => {
  it("has the layouts and attacks the pilot needs", () => {
    const names = fixtures.map((f) => f.name);
    for (const n of ["gmail-web-top-posted", "gmail-mobile", "outlook-desktop", "outlook-web", "outlook-mobile", "apple-mail", "bottom-posted", "html-only-outlook", "attachments-heavy", "forwarded-to-colleague", "adversarial-forwarded-rfq-as-offer", "adversarial-token-from-other-deal", "adversarial-token-from-other-vendor", "adversarial-mismatched-references", "duplicate-delivery"]) expect(names).toContain(n);
  });

  for (const f of fixtures) {
    it(`${f.name} (${f.client}) -> ${f.expect.outcome}${f.expect.quote_total_usd !== null ? ` $${f.expect.quote_total_usd}` : ""}`, async () => {
      const { p, map } = await pipeline();
      const detail = fillPlaceholders(f.detail, map);
      const results = [];
      for (let i = 0; i < (f.deliver_times ?? 1); i++) results.push(await p.deliver(detail, { eventId: i === 1 ? "evt_replay_1" : undefined, agentIdentities: f.event.agent_identities, files: filesOf(f) }));
      const r = results[0]!;
      expect(r.webhook_status).toBe(200);
      expect(r.outcome).toBe(f.expect.outcome);
      if (f.expect.stored_as !== undefined) expect(r.stored_as).toBe(f.expect.stored_as);
      if (f.expect.sender_trusted !== undefined) expect(r.sender_trusted).toBe(f.expect.sender_trusted);
      if (f.expect.trust_reason !== undefined) expect(r.trust_reason).toBe(f.expect.trust_reason);
      if (f.expect.quarantine_reason !== undefined) expect(r.quarantine_reason).toBe(f.expect.quarantine_reason);
      expect(r.quote_total_usd).toBe(f.expect.quote_total_usd);
      // A quote from mail verified only by the token is approvable (the human approves out of band) but never proof of identity.
      if (f.expect.quote_total_usd !== null) expect(r.approvable).toBe(true);
      // Quarantined mail never becomes a quote anywhere on the deal.
      if (r.stored_as === "quarantine") for (const d of p.deals.flat()) expect((await p.repo.listQuotes(d.jobId)).length).toBe(0);
      if ((f.deliver_times ?? 1) > 1) {
        expect(results.slice(1).map((x) => x.outcome)).toEqual(results.slice(1).map(() => "duplicate"));
        const jobId = p.deals[0]![0]!.jobId;
        expect((await p.repo.listMessages(jobId)).filter((m) => m.direction === "in")).toHaveLength(1);
        expect((await p.repo.listQuotes(jobId)).filter((q) => q.status === "current")).toHaveLength(1);
      }
    });
  }

  it("the default offline reader (keyword heuristic, as dry-run uses) still yields a quote, marked not approvable", async () => {
    const p = await replayPipeline({ buyer: BUYER, vendors: [VENDOR] });
    const v = p.deals[0]![0]!;
    const job = (await p.repo.getJob(v.jobId))!;
    const f = fixtures.find((x) => x.name === "gmail-web-top-posted")!;
    const r = await p.deliver(fillPlaceholders(f.detail, { BUYER, VENDOR: VENDOR.email, TOKEN: v.token, RFQ_MESSAGE_ID: v.rfqMessageId, RFQ_SUBJECT: p.mailbox.sent[0]!.subject, WHAT: job.request.what, AREA: job.request.area }));
    expect(r).toMatchObject({ outcome: "stored", trust_reason: "external-thread-reply", quote_total_usd: 1150, approvable: false });
  });
});

describe("Inkbox payloads typed with the installed SDK (0.7.x wire and detail types)", () => {
  const wire: MailWebhookPayload = {
    id: "evt_sdk_1", event_type: "message.received", timestamp: "2026-10-21T17:20:01.000Z",
    data: {
      message: {
        sender_access: "direct", id: "in_sdk_1", mailbox_id: "mbx_1", thread_id: "thr_1", message_id: "<CAsdk1@mail.gmail.com>", from_address: VENDOR.email, to_addresses: ["chef@valley.example"],
        cc_addresses: [BUYER], bcc_addresses: null, subject: "RE: quote", snippet: "$1,150 total", email_address: BUYER, body: "$1,150 total", body_state: "complete", body_truncated: false,
        body_total_chars: 12, body_included_chars: 12, direction: "inbound", status: "received", has_attachments: false, created_at: "2026-10-21T17:20:00.000Z",
      },
      contacts: [], agent_identities: [],
    },
  };
  // What messages.get returns (camelCase, parsed): assignable to the engine's InkboxMessageDetail.
  const sdkDetail: MessageDetail = {
    id: "in_sdk_1", mailboxId: "mbx_1", threadId: "thr_1", messageId: "<CAsdk1@mail.gmail.com>", fromAddress: VENDOR.email, fromDisplayName: "Maria", toAddresses: ["chef@valley.example"], ccAddresses: [BUYER],
    subject: "RE: quote", snippet: "$1,150 total", direction: "inbound" as MessageDetail["direction"], status: "received", isRead: false, isStarred: false, hasAttachments: false, createdAt: new Date("2026-10-21T17:20:00.000Z"),
    firstOpenedAt: null, openCount: 0, importJobId: null, bodyText: "$1,150 total", bodyHtml: null, bccAddresses: null, inReplyTo: "<rfq@email.amazonses.com>", references: ["<rfq@email.amazonses.com>"],
    attachmentMetadata: [{ filename: "q.pdf", content_type: "application/pdf", size: 1200 }], sesMessageId: null, updatedAt: new Date(), replyAllRecipients: null,
  };
  const engineDetail: InkboxMessageDetail = sdkDetail;

  it("the webhook route reads data.message.id; the detail maps field for field (incl. attachment metadata and Cc)", () => {
    expect(wire.data.message.id).toBe("in_sdk_1");
    const m = inkboxToInbound(wire, engineDetail);
    expect(m).toMatchObject({ providerEventId: "evt_sdk_1", providerEmailId: "in_sdk_1", threadId: "thr_1", messageId: "<CAsdk1@mail.gmail.com>", from: VENDOR.email, inReplyTo: ["<rfq@email.amazonses.com>"], references: ["<rfq@email.amazonses.com>"] });
    expect(m.attachments).toEqual([{ filename: "q.pdf", contentType: "application/pdf", sizeBytes: 1200, partIndex: 0, tarPath: "q.pdf" }]);
  });

  it("a reply-all with the buyer only in Cc is for the buyer (was dropped as not_for_buyer); Bcc-only is not", () => {
    expect(addressedToBuyer(engineDetail, BUYER)).toBe(true);
    expect(addressedToBuyer({ toAddresses: ["chef@valley.example"], ccAddresses: null }, BUYER)).toBe(false);
  });
});
