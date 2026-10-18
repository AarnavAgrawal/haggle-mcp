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
export * from "./outbound/imessageErrors.ts";
export * from "./ranking/rank.ts";
export * from "./ranking/value.ts";
export * from "./negotiation/strategist.ts";
export * from "./parsing/callSafety.ts";
export * from "./routing/channelStats.ts";
export * from "./reputation/places.ts";
export * from "./reputation/website.ts";
export * from "./outbound/primitiveSender.ts";
export * from "./payments/x402Challenge.ts";
export * from "./ids.ts";
export * from "./store/types.ts";
export * from "./store/memory.ts";
export * from "./workflow/stateMachine.ts";
export * from "./workflow/ports.ts";
export * from "./workflow/quotePart.ts";
export * from "./workflow/mapping.ts";
export * from "./workflow/engine.ts";
export * from "./brain/stubBrain.ts";
export * from "./brain/adapter.ts";
export * from "./sim/fleet.ts";
export * from "./mock.ts";
export * from "./store/postgres.ts";
export * from "./live/adapters.ts";
export * from "./live/inkbox.ts";
export * from "./payments/stripe.ts";
