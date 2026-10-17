/**
 * @haggle/engine — Yash's deal engine. Pure, contract-independent building blocks so far
 * (several adapted from quote-broker@8a68559; see docs/quote-broker-integration-audit.md).
 * Persistence, tools and brain calls are wired after `packages/core/contracts.ts` is frozen.
 */
export const ENGINE_PACKAGE = "@haggle/engine";

export * from "./money.ts";
export * from "./inbound/matching.ts";
export * from "./inbound/attachments.ts";
export * from "./inbound/primitive.ts";
export * from "./parsing/extraction.ts";
export * from "./parsing/validate.ts";
export * from "./parsing/requirements.ts";
export * from "./parsing/parseReply.ts";
export * from "./approvals/verifyApproval.ts";
export * from "./negotiation/counteroffer.ts";
export * from "./payments/guard.ts";
export * from "./outbound/rfq.ts";
export * from "./ranking/rank.ts";
export * from "./outbound/primitiveSender.ts";
export * from "./payments/x402Challenge.ts";
