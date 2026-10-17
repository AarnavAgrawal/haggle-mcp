// Shared error shape for every tool (DESIGN.md §8.1).
//
// Every expected failure becomes an MCP result with isError: true and a JSON
// body the agent can act on: a stable code, a message, whether a retry can
// help, and the next step to take.

export type ErrorCode =
  | "INVALID_INPUT"
  | "CONFIG_MISSING"
  | "SEND_FAILED"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_READY"
  | "JOB_ALREADY_FINISHED"
  | "QUOTE_NOT_FOUND"
  | "QUOTE_NOT_CURRENT"
  | "OVER_SPEND_CAP"
  | "APPROVAL_ALREADY_PENDING"
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_PENDING"
  | "APPROVAL_DECLINED"
  | "APPROVAL_EXPIRED"
  | "AMOUNT_MISMATCH"
  | "PAYMENT_FAILED"
  | "RATE_LIMITED"
  | "APPROVER_UNREACHABLE"
  | "INTERNAL";

export interface ToolErrorBody {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  next_step: string;
  details?: Record<string, unknown>;
}

/** Thrown inside tool code; converted to an isError result by runTool(). */
export class ToolError extends Error {
  constructor(public readonly body: ToolErrorBody) {
    super(body.message);
  }
}

export function toolError(
  code: ErrorCode,
  message: string,
  next_step: string,
  opts: { retryable?: boolean; details?: Record<string, unknown> } = {},
): ToolError {
  return new ToolError({ code, message, next_step, retryable: opts.retryable ?? false, details: opts.details });
}
