// LIVE MODE adapters for the engine ports. Each wraps one external service and is the only place
// that service is called. Adapted from quote-broker@8a68559 src/channels/email.ts (Primitive send,
// Message-ID lookup, attachment archive download) and src/parser/parseReply.ts (Claude).
import primitive from "@primitivedotdev/sdk";
import { getSentEmail } from "@primitivedotdev/sdk/api";
import { createX402Client } from "@primitivedotdev/sdk/x402";
import { privateKeyToAccount } from "viem/accounts";
import { extractAttachments, type ExtractedFile } from "../inbound/attachments.ts";
import { sendEmail, type SenderClient } from "../outbound/primitiveSender.ts";
import { answerFromRequest } from "../parsing/answerQuestion.ts";
import { heuristicExtract } from "../parsing/heuristic.ts";
import { isTransientParseError } from "../parsing/parseErrors.ts";
import { createAnthropicClient, parseReply, type ParserClient } from "../parsing/parseReply.ts";
import type { PayerClient } from "../payments/x402Challenge.ts";
import type { MessageRow } from "../store/types.ts";
import type { AttachmentPort, EmailPort, ExtractorPort, PayerPort } from "../workflow/ports.ts";
import { AiBudgetExceeded, meteredClient, type AiUsageMeter } from "./aiUsage.ts";

type PrimitiveClient = ReturnType<typeof primitive.client>;

export function primitiveEmail(apiKey: string): EmailPort & { client: PrimitiveClient } {
  const client = primitive.client({ apiKey });
  // The send response has Primitive's id, not the RFC Message-ID; look it up so replies match on In-Reply-To.
  const lookup = async (id: string) => {
    const res = await getSentEmail({ client: client.client, path: { id } });
    return (res.data?.data as { message_id?: string } | undefined)?.message_id ?? null;
  };
  return { client, send: (msg) => sendEmail(client as unknown as SenderClient, msg, lookup) };
}

/** `meter`: every Claude call is admitted against the AI usage limits and its tokens counted (aiUsage.ts). */
export function claudeExtractor(opts: { apiKey: string; workspaceId?: string; model: string; meter?: AiUsageMeter; client?: ParserClient }): ExtractorPort {
  const raw: ParserClient = opts.client ?? createAnthropicClient({ apiKey: opts.apiKey, ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}) });
  const client = opts.meter ? meteredClient(raw, opts.meter) : raw;
  return {
    extract: ({ request, bodyText, pdfs, images }) => parseReply(client, opts.model, { request, bodyText, pdfs, ...(images ? { images } : {}) }),
    answerQuestion: (input) => answerFromRequest(client, opts.model, input),
  };
}

/** The keyword fallback alone (no API key): low-confidence quotes, flagged for the agent. */
export const heuristicExtractor: ExtractorPort = {
  extract: async ({ request, bodyText }) => heuristicExtract({ request, bodyText }),
};

/**
 * Claude first. A busy or unreachable Claude (429/5xx/timeouts) is rethrown, so the engine reads the
 * reply again later (bounded, then an explicit "couldn't read" on the board). Only when Claude
 * can't read it at all (a refusal, no structured output) does the keyword fallback read it; its
 * figures are labelled "(heuristic)" and such a quote is never approvable or cited.
 */
export function withHeuristicFallback(primary: ExtractorPort, log?: (event: string, data: Record<string, unknown>) => void): ExtractorPort {
  return {
    async extract(input) {
      try {
        return await primary.extract(input);
      } catch (err) {
        // Over an AI usage limit: the read fails and the reply waits for a human; never a keyword quote.
        if (isTransientParseError(err) || err instanceof AiBudgetExceeded) throw err;
        log?.("extractor_fallback", { error: (err as Error).message.slice(0, 200) });
        return heuristicExtract({ request: input.request, bodyText: input.bodyText });
      }
    },
    // No keyword fallback for answering: when Claude can't, the question waits for the human.
    ...(primary.answerQuestion ? {
      async answerQuestion(input: Parameters<NonNullable<ExtractorPort["answerQuestion"]>>[0]) {
        try {
          return await primary.answerQuestion!(input);
        } catch (err) {
          log?.("answer_question_failed", { error: (err as Error).message.slice(0, 200) });
          return null;
        }
      },
    } : {}),
  };
}

/** True only for Primitive's own hosts: the API key is never sent anywhere else. */
export function isPrimitiveHost(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "primitive.dev" || u.hostname.endsWith(".primitive.dev"));
  } catch {
    return false;
  }
}

export function primitiveAttachments(apiKey: string, fetchImpl: typeof fetch = fetch): AttachmentPort {
  return {
    async load(m: MessageRow): Promise<ExtractedFile[]> {
      const inline = m.attachments.filter((a) => a.content_base64);
      const wanted = m.attachments.filter((a) => a.tar_path).map((a) => ({ tarPath: a.tar_path!, contentType: a.content_type, filename: a.filename }));
      const files: ExtractedFile[] = inline.map((a) => ({ kind: a.content_type === "application/pdf" ? ("pdf" as const) : ("json" as const), filename: a.filename ?? "attachment", data: Buffer.from(a.content_base64!, "base64") }));
      if (!m.attachments_download_url || wanted.length === 0) return files;
      if (!isPrimitiveHost(m.attachments_download_url)) throw new Error("attachment URL is not on Primitive");
      const res = await fetchImpl(m.attachments_download_url, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`attachment download failed (${res.status})`);
      return [...files, ...(await extractAttachments(Buffer.from(await res.arrayBuffer()), wanted))];
    },
  };
}

/** x402 payer: signs locally with the testnet key (never logged, never returned). */
export function x402Payer(opts: { apiKey: string; privateKey: string | undefined }): PayerPort {
  const client = createX402Client({ apiKey: opts.apiKey }) as unknown as PayerClient;
  if (!opts.privateKey || !/^0x[0-9a-fA-F]{64}$/.test(opts.privateKey)) {
    // No key: every payment attempt is refused by the SDK and recorded as SIGNING_REFUSED.
    return { client, signer: null, simulated: false };
  }
  return { client, signer: privateKeyToAccount(opts.privateKey as `0x${string}`), simulated: false };
}

/**
 * v5 live payer until Stripe test mode lands: refuses every signature, so a payment is recorded as
 * SIGNING_REFUSED and never faked. Needs no Primitive key or wallet.
 */
export function disabledPayer(reason: string): PayerPort {
  return { client: { payEmailChallenge: async () => { throw new Error(reason); } }, signer: null, simulated: false, disabledReason: reason };
}

/**
 * "Name <email>; Name <email>" -> demo fleet entries for discover (quote-broker DEMO_VENDORS format).
 * A bare address ("golden-grill-sf@inkboxmail.com") is accepted too, named after its local part,
 * so a fleet entry is never silently dropped from the recipient allowlist. ',' also separates.
 */
export function parseFleet(spec: string | undefined): { name: string; email: string }[] {
  if (!spec) return [];
  return spec.split(/[;,]/).map((s) => s.trim()).filter(Boolean).flatMap((s) => {
    const m = s.match(/^(.+?)\s*<([^>]+@[^>]+)>$/);
    if (m) return [{ name: m[1]!.trim(), email: m[2]!.trim().toLowerCase() }];
    if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s)) {
      const local = s.split("@")[0]!;
      return [{ name: local.replace(/[-_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), email: s.toLowerCase() }];
    }
    return [];
  });
}
