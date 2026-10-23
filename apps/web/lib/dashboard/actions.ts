// The deal page's actions (answer a business, message one, run the counteroffer round, cancel), as a
// pure function the POST route calls after checking membership. Only these four tools are reachable
// here; approve, pay and call_back are separate human-only flows (components/approval). The tool's
// `meta` is never returned (it can hold one-time approval codes).
import { z } from "zod";
import { HaggleError, type HaggleClient } from "../haggle";

const id = z.string().min(4).max(64);

export const ActionBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("answer_business"), question_id: z.string().min(3).max(64), answer: z.string().trim().min(1).max(2000) }),
  z.object({
    action: z.literal("send_message"),
    business_id: id,
    text: z.string().trim().max(1000).optional(),
    ask_missing: z.boolean().optional(),
    channel: z.enum(["email", "phone", "a2a", "imessage"]).optional(),
  }).refine((b) => !!b.text || b.ask_missing === true, { message: "Write a message, or choose to ask for what its quote is missing." }),
  z.object({ action: z.literal("negotiate"), business_ids: z.array(id).max(12).optional() }),
  /** The UI asks "are you sure?" first; the body must say so too. */
  z.object({ action: z.literal("cancel_deal"), confirm: z.literal(true) }),
]);
export type ActionBody = z.infer<typeof ActionBody>;

export interface ActionError {
  ok: false;
  error: { code: string; message: string; fix: string };
  next?: string | null;
}
export interface ActionOk {
  ok: true;
  action: ActionBody["action"];
  next: string | null;
  data: Record<string, unknown>;
}

export const isJobId = (s: string) => id.safeParse(s).success;

/** An error as the JSON body and HTTP status the dashboard shows (message + fix). */
export function errorJson(err: unknown): { status: number; body: ActionError } {
  if (err instanceof HaggleError) {
    // An HTTP refusal from the MCP server (bad service token, server down) is a gateway problem here.
    return { status: err.status ? 502 : 422, body: { ok: false, error: { code: err.code, message: err.message, fix: err.fix }, next: err.next } };
  }
  return { status: 502, body: { ok: false, error: { code: "unreachable", message: "The Haggle server couldn't be reached.", fix: "Try again in a moment." } } };
}

type Caller = Pick<HaggleClient, "callTool">;

export async function runDealAction(haggle: Caller, jobId: string, raw: unknown): Promise<{ status: number; body: ActionOk | ActionError }> {
  if (!isJobId(jobId)) return { status: 400, body: { ok: false, error: { code: "bad_job_id", message: "That deal id isn't valid.", fix: "Open the deal from the deals list." } } };
  const parsed = ActionBody.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "The request is missing something.";
    return { status: 400, body: { ok: false, error: { code: "bad_request", message: msg, fix: "Check the form and try again." } } };
  }
  const b = parsed.data;
  const args: Record<string, unknown> =
    b.action === "answer_business" ? { job_id: jobId, question_id: b.question_id, answer: b.answer }
      : b.action === "send_message" ? { job_id: jobId, business_id: b.business_id, ...(b.text ? { text: b.text } : {}), ...(b.ask_missing ? { ask_missing: true } : {}), ...(b.channel ? { channel: b.channel } : {}) }
      : b.action === "negotiate" ? { job_id: jobId, ...(b.business_ids?.length ? { business_ids: b.business_ids } : {}) }
      : { job_id: jobId };
  try {
    const { data } = await haggle.callTool<Record<string, unknown>>(b.action, args);
    return { status: 200, body: { ok: true, action: b.action, next: typeof data.next === "string" ? data.next : null, data } };
  } catch (err) {
    return errorJson(err);
  }
}
