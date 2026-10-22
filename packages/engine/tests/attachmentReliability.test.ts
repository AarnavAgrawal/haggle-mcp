// Attachment reliability on the live (Inkbox) path: size caps enforced while downloading (metadata
// sizes can be 0 or wrong), bytes checked against what they claim, several attachments sharing the
// per-kind budgets, retryable vs permanent download failures, and a PDF whose total disagrees with
// the email body. Fixture PDF from fixtures/buyer (read-only). Fakes only; no network.
import { readFileSync } from "node:fs";
import { InkboxAPIError } from "@inkbox/sdk";
import { describe, expect, it } from "vitest";
import {
  disabledPayer, GOLDEN_REQUEST, HaggleEngine, inkboxAttachments, InMemoryRepository, MAX_PDF_BYTES, sniffAttachment, StubBrain, verifiedKind,
  type MessageRow, type QuoteExtraction, type StoredAttachment,
} from "../src/index.ts";
import { isTransientParseError } from "../src/parsing/parseErrors.ts";
import { pdfBodyTotalConflict, statedBodyTotals } from "../src/parsing/pdfBody.ts";
import { BUYER, FakeInkbox } from "./helpers/fakeInkbox.ts";

const PDF = readFileSync(new URL("../../../fixtures/buyer/attachments/golden-gate-quote-hidden-deposit.pdf", import.meta.url));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const HTML = Buffer.from("<!doctype html><html><body>Sign in to view your document</body></html>");

const row = (attachments: StoredAttachment[]): MessageRow => ({
  id: "msg_1", job_id: "job_1", business_id: "b", approval_id: null, direction: "in", kind: "reply", provider_email_id: "in_1", idempotency_key: null, rfc_message_id: null, thread_id: null,
  from_address: "v@x.example", to_address: BUYER, subject: null, body_text: "see attached", attachments, attachments_download_url: null, sender_trusted: true, trust_reason: "trusted",
  matched_via: "thread", parse_status: "pending", quarantine_reason: null, round: null, simulated: false, channel: "email", created_at: new Date().toISOString(),
});
const att = (filename: string, content_type: string, size_bytes = 0): StoredAttachment => ({ filename, content_type, size_bytes, tar_path: filename });

/** Serves files by name; records which were requested and how many bytes were pulled from each stream. */
function server(files: Record<string, Buffer | { status: number } | { stream: number; chunk: number }>, opts: { contentLength?: boolean } = {}) {
  const requested: string[] = [];
  const pulled: Record<string, number> = {};
  const fetchImpl = (async (url: string) => {
    const name = decodeURIComponent(url.split("/").pop()!);
    requested.push(name);
    const f = files[name];
    if (!f) return new Response("missing", { status: 404 });
    if ("status" in f) return new Response("err", { status: f.status });
    if ("stream" in f) {
      let sent = 0;
      pulled[name] = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent >= f.stream) return c.close();
          const n = Math.min(f.chunk, f.stream - sent);
          sent += n;
          pulled[name] = sent;
          c.enqueue(new Uint8Array(n).fill(0x25));
        },
      });
      return new Response(body, { status: 200 });
    }
    return new Response(f, { status: 200, headers: opts.contentLength === false ? {} : { "content-length": String(f.byteLength) } });
  }) as unknown as typeof fetch;
  return { fetchImpl, requested, pulled };
}

describe("inkboxAttachments: caps, types, budgets, failures", () => {
  it("a file whose metadata says 0 bytes but streams past the cap is cut off while downloading, not read whole", async () => {
    const s = server({ "huge.pdf": { stream: MAX_PDF_BYTES * 4, chunk: 256 * 1024 } });
    const files = await inkboxAttachments(new FakeInkbox(), BUYER, s.fetchImpl).load(row([att("huge.pdf", "application/pdf", 0)]));
    expect(files).toEqual([]);
    expect(s.pulled["huge.pdf"]).toBeLessThanOrEqual(MAX_PDF_BYTES + 2 * 256 * 1024); // the stream may prefetch a chunk; the old reader pulled all 4x
  });

  it("a declared Content-Length over the cap is skipped without reading the body", async () => {
    const big = Buffer.alloc(MAX_PDF_BYTES + 10, 0x25);
    const s = server({ "big.pdf": big });
    expect(await inkboxAttachments(new FakeInkbox(), BUYER, s.fetchImpl).load(row([att("big.pdf", "application/pdf", 100)]))).toEqual([]);
  });

  it("bytes decide the kind: an HTML page named .pdf is skipped, a JPEG named .pdf is read as an image, non-JSON quote.json is dropped", async () => {
    const s = server({ "quote.pdf": HTML, "photo.pdf": JPEG, "quote.json": Buffer.from("not json"), "real.pdf": PDF });
    const files = await inkboxAttachments(new FakeInkbox(), BUYER, s.fetchImpl).load(row([
      att("quote.pdf", "application/pdf"), att("photo.pdf", "application/pdf"), att("quote.json", "application/json"), att("real.pdf", "application/octet-stream"), att("notes.txt", "text/plain"), att("evil.exe", "application/x-msdownload"),
    ]));
    expect(files.map((f) => [f.filename, f.kind, f.contentType ?? null])).toEqual([["photo.pdf", "image", "image/jpeg"], ["real.pdf", "pdf", null]]);
    expect(s.requested).not.toContain("notes.txt");
    expect(s.requested).not.toContain("evil.exe");
  });

  it("several attachments share the per-kind budget: PDFs up to the total cap, images separately", async () => {
    const half = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(Math.floor(MAX_PDF_BYTES / 2) - 20, 0x20)]);
    const s = server({ "a.pdf": half, "b.pdf": half, "c.pdf": half, "menu.png": PNG });
    const files = await inkboxAttachments(new FakeInkbox(), BUYER, s.fetchImpl).load(row([att("a.pdf", "application/pdf"), att("b.pdf", "application/pdf"), att("c.pdf", "application/pdf"), att("menu.png", "image/png")]));
    expect(files.map((f) => f.filename)).toEqual(["a.pdf", "b.pdf", "menu.png"]);
  });

  it("an Inkbox outage (5xx, 429) is retryable; a missing attachment (404) is not", async () => {
    const load = (status: number) => inkboxAttachments(new FakeInkbox(), BUYER, server({ "q.pdf": { status } }).fetchImpl).load(row([att("q.pdf", "application/pdf")])).catch((e: unknown) => e);
    expect(isTransientParseError(await load(503))).toBe(true);
    expect(isTransientParseError(await load(429))).toBe(true);
    expect(isTransientParseError(await load(404))).toBe(false);
    const api = new FakeInkbox();
    api.getAttachment = async () => { throw new InkboxAPIError(502, "bad gateway"); };
    const e = await inkboxAttachments(api, BUYER, server({}).fetchImpl).load(row([att("q.pdf", "application/pdf")])).catch((x: unknown) => x);
    expect(isTransientParseError(e)).toBe(true);
  });

  it("sniffAttachment / verifiedKind", () => {
    expect(sniffAttachment(PDF)).toEqual({ kind: "pdf" });
    expect(sniffAttachment(Buffer.concat([Buffer.alloc(100, 0x20), Buffer.from("%PDF-1.7")]))).toEqual({ kind: "pdf" });
    expect(sniffAttachment(PNG)).toEqual({ kind: "image", contentType: "image/png" });
    expect(sniffAttachment(Buffer.from("GIF89a...."))).toEqual({ kind: "image", contentType: "image/gif" });
    expect(sniffAttachment(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toEqual({ kind: "image", contentType: "image/webp" });
    expect(sniffAttachment(HTML)).toBeNull();
    expect(verifiedKind("json", Buffer.from('﻿  {"a":1}'))).toEqual({ kind: "json" });
    expect(verifiedKind("json", Buffer.from("<xml/>"))).toBeNull();
  });
});

describe("a PDF total that disagrees with the email body", () => {
  const x = (total: number, source: string) => ({ total_usd: total, sources: [{ field: "total" as const, source, excerpt: "" }] });
  it("finds the totals a body states", () => {
    expect(statedBodyTotals("Our price is $1,150 total. Total: $1,200.50. All-in $99 is wrong")).toEqual(expect.arrayContaining([115000, 120050]));
    expect(statedBodyTotals("We have 40 seats and a $50 delivery fee")).toEqual([]);
  });
  it("flags only a PDF-sourced total the body contradicts", () => {
    expect(pdfBodyTotalConflict(x(1400, "pdf p.1"), "Quote attached: $1,150 total.")).toEqual({ pdfCents: 140000, bodyCents: [115000] });
    expect(pdfBodyTotalConflict(x(1150, "pdf p.1"), "Quote attached: $1,150 total.")).toBeNull();
    expect(pdfBodyTotalConflict(x(1155, "pdf p.2"), "about $1,150 total")).toBeNull(); // within 1%
    expect(pdfBodyTotalConflict(x(1400, "email body"), "$1,150 total")).toBeNull();
    expect(pdfBodyTotalConflict(x(1400, "pdf p.1"), "Please see the attached quote.")).toBeNull();
  });

  it("end to end: the quote is kept (the extractor's reading) but flagged conflicting_numbers for the human", async () => {
    const extraction: QuoteExtraction = {
      available: true, price_per_head_usd: null, headcount: 40, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true, total_usd: 1400, deposit_usd: null,
      menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }], valid_until: null, questions: [], payment_request: "none", instructions_to_agent: false,
      sources: [{ field: "total", source: "pdf p.1", excerpt: "Total $1,400" }], missing_fields: [], confidence: 0.9,
    };
    const seen: { body: string; pdfs: number }[] = [];
    const api = new FakeInkbox();
    const repo = new InMemoryRepository();
    const engine = new HaggleEngine({
      repo, extractor: { extract: async (i) => { seen.push({ body: i.bodyText, pdfs: i.pdfs.length }); return extraction; } }, attachments: inkboxAttachments(api, BUYER, server({ "quote.pdf": PDF }).fetchImpl),
      brain: new StubBrain(), payer: disabledPayer("off"), email: { async send() { return { providerId: "em_1", status: "sent", idempotentReplay: false, messageId: "<em_1@x>" }; } },
      config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: BUYER, collectionWindowMs: 600_000, negotiationWindowMs: 300_000, approvalTtlMs: 1_800_000, globalPaymentCapCents: 500_000, maxRounds: 1 },
    });
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Golden Gate", email: "gg@inkboxmail.test" }] });
    const trusted = (e: string) => ({ trusted: true as const, address: e, reason: "trusted" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });
    await engine.ingest({ providerEventId: "e1", eventType: "message.received", providerEmailId: "in_1", threadId: "t", messageId: "<in1@x>", inReplyTo: ["<em_1@x>"], references: ["<em_1@x>"], from: "gg@inkboxmail.test", to: [BUYER], subject: "Re: quote", bodyText: "Hi! $1,150 total, quote attached.\n\nOn Thu, Oct 22, 2026 at 10:15 AM Haggle <haggle@inkboxmail.test> wrote:\n> Budget $2,000 total", attachments: [{ filename: "quote.pdf", contentType: "application/pdf", sizeBytes: PDF.byteLength, partIndex: 0, tarPath: "quote.pdf" }], attachmentsDownloadUrl: null }, trusted);
    await engine.advanceJob(deal.job_id);
    expect(seen).toEqual([{ body: "Hi! $1,150 total, quote attached.", pdfs: 1 }]);
    const q = (await engine.getQuotes(deal.job_id)).quotes[0]!;
    expect(q.total_usd).toBe(1400);
    expect(q.flags).toContain("conflicting_numbers");
  });
});
