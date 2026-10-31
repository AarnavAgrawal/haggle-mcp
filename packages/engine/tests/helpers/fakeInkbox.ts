// Shared Inkbox test fakes (no network): a signed-webhook helper and an in-memory Inkbox mail API.
// Used by the engine's Inkbox tests and the MCP server's /webhooks/inkbox route test.
import { createHmac } from "node:crypto";
import { InkboxAPIError } from "@inkbox/sdk";
import type { InkboxMailApi, InkboxMessageDetail } from "../../src/index.ts";

export const SECRET = "whsec_dGVzdC1zZWNyZXQ"; // fake test key (base64 "test-secret") gitleaks:allow
export const BUYER = "haggle@inkboxmail.test";

export function signed(body: string, opts: { secret?: string; ts?: string; tamper?: boolean } = {}): Headers {
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const key = (opts.secret ?? SECRET).replace(/^whsec_/, "");
  const sig = createHmac("sha256", key).update(`req_1.${ts}.${body}`).digest("hex");
  return new Headers({ "x-inkbox-signature": `sha256=${sig}`, "x-inkbox-request-id": "req_1", "x-inkbox-timestamp": ts, ...(opts.tamper ? {} : {}) });
}

/** In-memory Inkbox mail: mailboxes keyed by address; outbound messages get RFC Message-IDs. */
export class FakeInkbox implements InkboxMailApi {
  sent: { mailbox: string; o: Parameters<InkboxMailApi["send"]>[1] }[] = [];
  messages = new Map<string, InkboxMessageDetail & { mailbox: string; direction: string }>();
  failNext: number[] = [];
  listError: InkboxAPIError | Error | null = null;
  private n = 0;
  async send(mailbox: string, o: Parameters<InkboxMailApi["send"]>[1]) {
    const code = this.failNext.shift();
    if (code) throw new InkboxAPIError(code, "unavailable");
    const prior = this.sent.find((s) => s.o.idempotencyKey && s.o.idempotencyKey === o.idempotencyKey);
    const id = prior ? `m_${this.sent.indexOf(prior) + 1}` : `m_${++this.n}`;
    if (!prior) {
      this.sent.push({ mailbox, o });
      this.messages.set(id, { id, mailbox, direction: "outbound", threadId: `t_${o.to[0]}`, messageId: `<${id}@inkbox.test>`, fromAddress: mailbox, toAddresses: o.to, subject: o.subject, bodyText: o.bodyText ?? null, inReplyTo: o.inReplyToMessageId ?? null, references: null, attachmentMetadata: null });
    }
    return { id, messageId: `<${id}@inkbox.test>`, status: "queued" };
  }
  /** A seller mailbox (Inkbox identity) sends a reply to the buyer (or to `opts.to`, e.g. a workspace mailbox). */
  reply(from: string, inReplyTo: string, text: string, attachments: Record<string, unknown>[] = [], opts: { recordOutbound?: boolean; to?: string } = {}) {
    const id = `in_${++this.n}`;
    const rfc = `<${id}@${from.split("@")[1]}>`;
    const to = opts.to ?? BUYER;
    const detail = { id, mailbox: to, direction: "inbound", threadId: `t_${from}`, messageId: rfc, fromAddress: from, toAddresses: [to], subject: "Re: Quote request", bodyText: text, inReplyTo, references: [inReplyTo], attachmentMetadata: attachments };
    this.messages.set(id, detail);
    if (opts.recordOutbound !== false) this.messages.set(`out_${id}`, { ...detail, id: `out_${id}`, mailbox: from, direction: "outbound" });
    return detail;
  }
  async get(_mailbox: string, id: string) {
    const m = this.messages.get(id);
    if (!m) throw new InkboxAPIError(404, "not found");
    return m;
  }
  async getAttachment(_mailbox: string, id: string, filename: string) {
    return { url: `https://files.inkbox.test/${id}/${filename}` };
  }
  async *list(mailbox: string, o?: { direction?: string }) {
    if (this.listError) throw this.listError;
    for (const m of [...this.messages.values()].reverse()) if (m.mailbox === mailbox && (!o?.direction || m.direction === o.direction)) yield m;
  }
}
