// Email channel over Primitive (DESIGN.md §10).
import primitive from "@primitivedotdev/sdk";
import { getSentEmail, replyToEmail } from "@primitivedotdev/sdk/api";
import { getConfig } from "../config.js";
import type { ChannelAdapter, OutboundMessage, SendResult } from "./types.js";

type PrimitiveClient = ReturnType<typeof primitive.client>;
let client: PrimitiveClient | undefined;

export function primitiveClient(): PrimitiveClient {
  if (!client) client = primitive.client({ apiKey: getConfig().PRIMITIVE_API_KEY });
  return client;
}

/**
 * The send response carries only Primitive's id, not the RFC Message-ID.
 * Look the sent email up once so inbound replies can be matched on
 * In-Reply-To. Best effort: matching still works on thread id or subject tag.
 */
async function lookupMessageId(sentId: string): Promise<string | undefined> {
  try {
    const res = await getSentEmail({ client: primitiveClient().client, path: { id: sentId } });
    return res.data?.data?.message_id ?? undefined;
  } catch {
    return undefined;
  }
}

export const emailChannel: ChannelAdapter & {
  replyTo(parentInboundId: string, bodyText: string, idempotencyKey: string): Promise<SendResult>;
} = {
  channel: "email",

  /** Start a new thread. */
  async send(msg: OutboundMessage): Promise<SendResult> {
    const cfg = getConfig();
    const result = await primitiveClient().send(
      { from: cfg.PRIMITIVE_FROM_ADDRESS, to: msg.to, subject: msg.subject, bodyText: msg.bodyText },
      // Idempotency-Key makes retries safe: the same key never sends twice.
      { idempotencyKey: msg.idempotencyKey, timeout: 15_000 },
    );
    if (result.rejected.length > 0 && result.accepted.length === 0) {
      throw new Error(`recipient rejected (${result.status})`);
    }
    return { providerId: result.id, messageId: await lookupMessageId(result.id) };
  },

  /**
   * Reply inside an existing thread (POST /v1/emails/{id}/reply). Primitive
   * derives In-Reply-To, References, and the "Re:" subject from the inbound
   * email, so Gmail and Outlook keep the conversation together.
   */
  async replyTo(parentInboundId: string, bodyText: string, idempotencyKey: string): Promise<SendResult> {
    const res = await replyToEmail({
      client: primitiveClient().client,
      path: { id: parentInboundId },
      body: { body_text: bodyText, from: getConfig().PRIMITIVE_FROM_ADDRESS },
      headers: { "Idempotency-Key": idempotencyKey },
    });
    const id = (res.data?.data as { id?: string } | undefined)?.id;
    if (res.error || !id) throw new Error(`reply failed (${res.response?.status ?? "no response"})`);
    return { providerId: id, messageId: await lookupMessageId(id) };
  },
};

/**
 * Download an inbound email's attachments archive (tar.gz). The URL comes from
 * a signature-verified webhook; the API key is only attached when the URL is
 * on Primitive's own domain. TODO(verify): whether the URL is pre-signed (no
 * auth needed) or requires the API key.
 */
export async function downloadAttachmentsArchive(url: string): Promise<Buffer> {
  const host = new URL(url).hostname;
  const isPrimitive = host === "primitive.dev" || host.endsWith(".primitive.dev");
  const res = await fetch(url, {
    headers: isPrimitive ? { Authorization: `Bearer ${getConfig().PRIMITIVE_API_KEY}` } : {},
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`attachment download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}
