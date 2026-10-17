// Ported from quote-broker@8a68559 tests/fixtures/primitiveEvent.ts (Partner). A builder for
// schema-valid signed-webhook test events (code, not reply data, so it lives with the engine tests).
// Builds schema-valid Primitive webhook events for tests. The webhook handler
// runs the SDK's real signature check and schema validation on these, so the
// safety tests exercise the same code path as production.
import { createHash } from "node:crypto";
import type { EmailReceivedEvent } from "@primitivedotdev/sdk/webhook";

export interface EventOptions {
  id?: string;
  event?: "email.received" | "email.bounced";
  endpointId?: string;
  from?: string; // bare address
  fromName?: string;
  to?: string;
  subject?: string;
  bodyText?: string | null;
  threadId?: string | null;
  inReplyTo?: string[];
  /** DMARC/DKIM outcome for the From domain. "pass" makes the sender trusted. */
  auth?: "pass" | "fail";
  bounceSentEmailId?: string;
}

const hex = (s: string) => createHash("sha256").update(s).digest("hex");
let counter = 0;

export function buildEvent(opts: EventOptions = {}): EmailReceivedEvent {
  const n = ++counter;
  const from = opts.from ?? "quotes@bay-catering.primitive.email";
  const domain = from.split("@")[1]!;
  const pass = (opts.auth ?? "pass") === "pass";
  const now = new Date().toISOString();

  return {
    id: opts.id ?? `evt_${hex(`event-${n}-${Math.random()}`)}`,
    event: opts.event ?? "email.received",
    version: "2025-12-14",
    delivery: { endpoint_id: opts.endpointId ?? "ep_test", attempt: 1, attempted_at: now },
    email: {
      id: `em_${n}`,
      thread_id: opts.threadId ?? null,
      received_at: now,
      smtp: { helo: "mx.test", mail_from: from, rcpt_to: [opts.to ?? "job-7f3k@brave-dog.primitive.email"] },
      headers: {
        message_id: `<msg-${n}@${domain}>`,
        subject: opts.subject ?? "Re: Catering quote request [HG-7F3K]",
        from: opts.fromName ? `"${opts.fromName}" <${from}>` : from,
        to: opts.to ?? "job-7f3k@brave-dog.primitive.email",
        date: now,
      },
      content: { raw: null, download: null },
      parsed: {
        status: "complete",
        error: null,
        body_text: opts.bodyText === undefined ? "We can do $22 per head." : opts.bodyText,
        body_html: null,
        reply_to: null,
        cc: null,
        bcc: null,
        to_addresses: null,
        in_reply_to: opts.inReplyTo ?? null,
        references: null,
        attachments: [],
        attachments_download_url: null,
      },
      analysis: opts.bounceSentEmailId
        ? {
            bounce: {
              is_bounce: true,
              kind: "dsn",
              type: "permanent",
              category: "mailbox_does_not_exist",
              classified_by: "status_code",
              failed_recipient: from,
              sent_email_id: opts.bounceSentEmailId,
              smtp_code: 550,
              status_code: "5.1.1",
              diagnostic_code: null,
              reported_by_mta: null,
              original_message_id: null,
              reasons: ["mailbox does not exist"],
            },
          }
        : {},
      auth: {
        spf: pass ? "pass" : "fail",
        dmarc: pass ? "pass" : "fail",
        dmarcPolicy: "reject",
        dmarcFromDomain: domain,
        dmarcSpfAligned: pass,
        dmarcDkimAligned: pass,
        dmarcSpfStrict: null,
        dmarcDkimStrict: null,
        dkimSignatures: [
          { domain, selector: "s1", result: pass ? "pass" : "fail", aligned: pass, keyBits: 2048, algo: "rsa-sha256" },
        ],
      },
    },
  } as EmailReceivedEvent;
}
