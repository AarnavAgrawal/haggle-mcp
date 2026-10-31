// LIVE MODE extractor ports: Claude (structured outputs) with an explicit keyword fallback.
// Adapted from quote-broker@8a68559 src/parser/parseReply.ts (Claude).
import { answerFromRequest } from "../parsing/answerQuestion.ts";
import { judgePriceWithClaude } from "../parsing/priceJudgment.ts";
import { heuristicExtract } from "../parsing/heuristic.ts";
import { isTransientParseError } from "../parsing/parseErrors.ts";
import { createAnthropicClient, parseReply, type ParserClient } from "../parsing/parseReply.ts";
import type { ExtractorPort } from "../workflow/ports.ts";
import { AiBudgetExceeded, meteredClient, type AiUsageMeter } from "./aiUsage.ts";

/** `meter`: every Claude call is admitted against the AI usage limits and its tokens counted (aiUsage.ts). */
export function claudeExtractor(opts: { apiKey: string; workspaceId?: string; model: string; meter?: AiUsageMeter; client?: ParserClient }): ExtractorPort {
  const raw: ParserClient = opts.client ?? createAnthropicClient({ apiKey: opts.apiKey, ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}) });
  const client = opts.meter ? meteredClient(raw, opts.meter) : raw;
  return {
    extract: ({ request, bodyText, pdfs, images }) => parseReply(client, opts.model, { request, bodyText, pdfs, ...(images ? { images } : {}) }),
    answerQuestion: (input) => answerFromRequest(client, opts.model, input),
    judgePrice: (input) => judgePriceWithClaude(client, opts.model, input),
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
    // No fallback for a price judgment either: when Claude can't (busy, over the AI budget), the
    // deterministic check stands.
    ...(primary.judgePrice ? {
      async judgePrice(input: Parameters<NonNullable<ExtractorPort["judgePrice"]>>[0]) {
        try {
          return await primary.judgePrice!(input);
        } catch (err) {
          log?.("price_judgment_failed", { error: (err as Error).message.slice(0, 200) });
          return null;
        }
      },
    } : {}),
  };
}
