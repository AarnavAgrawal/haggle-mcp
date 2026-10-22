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
export * from "./parsing/heuristic.ts";
export * from "./parsing/answerQuestion.ts";
export * from "./inbound/emailBody.ts";
export * from "./inbound/htmlText.ts";
export * from "./inbound/senderAuth.ts";
export * from "./negotiation/messageGuard.ts";
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
export * from "./workflow/callPolicy.ts";
export * from "./brain/stubBrain.ts";
export * from "./brain/adapter.ts";
export * from "./sim/fleet.ts";
export * from "./mock.ts";
export * from "./store/postgres.ts";
export * from "./live/adapters.ts";
export * from "./live/inkbox.ts";
export * from "./live/reconcile.ts";
export * from "./live/transient.ts";
export * from "./payments/stripe.ts";
export * from "./workflow/deadLetter.ts";
export * from "./workflow/recovery.ts";
export * from "./live/log.ts";
export * from "./live/alerts.ts";
export * from "./live/aiUsage.ts";
export * from "./ops/stalled.ts";
export * from "./ops/migrations.ts";
// Workstream D: purchase after approval, compliance, freshness, request normalization.
export * from "./payments/purchase.ts";
export * from "./ranking/compliance.ts";
export * from "./ranking/validity.ts";
export * from "./approvals/bookingReply.ts";
export * from "./workflow/requestNormalize.ts";
export * from "./ops/traction.ts";
// Sprint 4 workstream A: contact hours, per-business contact status, operator review of held mail, continuity vs identity.
export * from "./workflow/contactWindow.ts";
export * from "./inbound/contactStatus.ts";
export * from "./inbound/quarantineReview.ts";
export * from "./inbound/trustStrength.ts";
// Sprint 4 B: why each quote was selected or rejected.
export * from "./ranking/selection.ts";
export * from "./store/poolGate.ts";
// Workstream F (sprint 4): reconciler catch-up, the operator report.
export * from "./live/reconcileWindow.ts";
export * from "./ops/report.ts";
// Sprint 5 B: operator actions (audit, suspension, approver verification, reviewed requests) and the vendor roster.
export * from "./ops/operator.ts";
export * from "./ops/roster.ts";
// Sprint 5 E: usage metrics from database rows (simulated vs real), approximate AI cost.
export * from "./ops/costs.ts";
export * from "./ops/metrics.ts";
