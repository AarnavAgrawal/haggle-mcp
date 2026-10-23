// One chat turn: the user's message, then a manual streaming tool loop against Claude with the
// Haggle MCP tools the model may call (lib/tools.ts). Dependencies are injected (the Anthropic client
// and the Haggle client) so tests run with fakes.
//
// Safety (CLAUDE.md §7): only allowlisted tools ever reach the Haggle server (approve / pay /
// call_back are the human's buttons); a tool result carries the tool's text and data, never `meta`
// (it can hold one-time approval codes).
import type Anthropic from "@anthropic-ai/sdk";
import { HaggleError, type HaggleClient } from "../haggle";
import { isLlmTool, llmToolDefinitions } from "../tools";
import { CHAT_SYSTEM_PROMPT } from "./prompt";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type ToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;
type ToolUnion = Anthropic.Beta.BetaToolUnion;
type BetaMessage = Anthropic.Beta.BetaMessage;
type StreamParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/** What the browser receives (newline-delimited JSON). */
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; status: "start" | "done" | "error"; summary: string }
  | { type: "deal"; job_id: string }
  | { type: "done"; thread_id?: string }
  | { type: "error"; message: string };

/** Just the part of the Anthropic SDK this loop uses (the real client satisfies it). */
export interface ChatModelClient {
  beta: {
    messages: {
      stream(
        body: StreamParams,
        options?: { signal?: AbortSignal | null | undefined },
      ): { on(event: "text", listener: (delta: string, snapshot: string) => void): unknown; finalMessage(): Promise<BetaMessage> };
    };
  };
}

export type ChatHaggle = Pick<HaggleClient, "listTools" | "callTool">;

export const DEFAULT_CHAT_MODEL = "claude-opus-5-5";
export const MAX_MODEL_CALLS = 12;
export const WAIT_TIMEOUT_CAP_S = 20;
export const TOOL_RESULT_CAP = 6000;
/** Marks the per-request context block in a user turn (hidden in the UI). */
export const CONTEXT_PREFIX = "[Haggle context] ";

export interface RunChatTurnOptions {
  anthropic: ChatModelClient;
  haggle: ChatHaggle;
  /** Earlier turns of this thread, as persisted (append-only). */
  history: MessageParam[];
  userText: string;
  onEvent: (e: ChatEvent) => void;
  signal?: AbortSignal;
  model?: string;
  /** Overrides for tests. */
  today?: Date;
  maxModelCalls?: number;
}

export interface ChatTurnResult {
  /** The new messages to persist: the user turn, then assistant turns and tool results. */
  messages: MessageParam[];
  /** The job a real (non-dry-run) deal started in this turn. */
  jobId?: string;
}

const isAbort = (e: unknown, signal?: AbortSignal) =>
  !!signal?.aborted || (e instanceof Error && (e.name === "AbortError" || e.name === "APIUserAbortError"));

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 20)}\n…[truncated]` : s);
const firstLine = (s: string, n = 160) => {
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

/** The user turn: their words, plus today's date as a separate context block (keeps the system prompt stable). */
export function userTurn(text: string, today: Date): MessageParam {
  const day = today.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  return {
    role: "user",
    content: [
      { type: "text", text },
      { type: "text", text: `${CONTEXT_PREFIX}Today's date (UTC) is ${day} (${today.toISOString().slice(0, 10)}).` },
    ],
  };
}

/** Tool definitions for the API, the last one marked as a prompt-cache breakpoint. */
export async function chatTools(haggle: ChatHaggle): Promise<ToolUnion[]> {
  const defs = await llmToolDefinitions(haggle as HaggleClient);
  return defs.map((d, i) => ({
    name: d.name,
    description: d.description,
    input_schema: { type: "object" as const, ...d.inputSchema },
    ...(i === defs.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
}

/** A deal that really started (not a dry run) and its job id. */
export function startedJobId(name: string, input: Record<string, unknown>, data: unknown): string | undefined {
  if (name !== "deal" || input.dry_run === true) return undefined;
  const d = (data ?? {}) as { dry_run?: unknown; job_id?: unknown; job?: { id?: unknown } | null };
  if (d.dry_run === true) return undefined;
  const id = typeof d.job_id === "string" ? d.job_id : typeof d.job?.id === "string" ? d.job.id : undefined;
  return id || undefined;
}

interface ToolOutcome {
  result: ToolResultBlockParam;
  jobId?: string;
}

/** Runs one tool_use block: allowlist first, then the Haggle server. Never forwards `meta`. */
export async function runTool(haggle: ChatHaggle, block: { id: string; name: string; input: unknown }, onEvent: (e: ChatEvent) => void, signal?: AbortSignal): Promise<ToolOutcome> {
  const errorResult = (text: string): ToolOutcome => ({ result: { type: "tool_result", tool_use_id: block.id, is_error: true, content: text } });
  if (!isLlmTool(block.name)) {
    onEvent({ type: "tool", name: block.name, status: "error", summary: "Not available in chat" });
    return errorResult(
      `The tool "${block.name}" is not available here. Approving, paying and authorizing callbacks are done only by the human with the buttons on the deal dashboard (/deals/<job_id>); point the user there.`,
    );
  }
  const input: Record<string, unknown> = block.input && typeof block.input === "object" && !Array.isArray(block.input) ? { ...(block.input as Record<string, unknown>) } : {};
  if (block.name === "wait_for_update") {
    const t = typeof input.timeout_s === "number" ? input.timeout_s : WAIT_TIMEOUT_CAP_S;
    input.timeout_s = Math.max(0, Math.min(Math.floor(t), WAIT_TIMEOUT_CAP_S));
  }
  onEvent({ type: "tool", name: block.name, status: "start", summary: startSummary(block.name, input) });
  try {
    const r = await haggle.callTool(block.name, input, signal);
    // Only the model-facing text and the structured data; `meta` is deliberately dropped.
    const content = cap(`${r.text}\n\ndata: ${JSON.stringify(r.data ?? {})}`, TOOL_RESULT_CAP);
    const jobId = startedJobId(block.name, input, r.data);
    onEvent({ type: "tool", name: block.name, status: "done", summary: doneSummary(block.name, input, r.text, jobId) });
    if (jobId) onEvent({ type: "deal", job_id: jobId });
    return { result: { type: "tool_result", tool_use_id: block.id, content }, ...(jobId ? { jobId } : {}) };
  } catch (e) {
    if (isAbort(e, signal)) throw e;
    if (e instanceof HaggleError) {
      onEvent({ type: "tool", name: block.name, status: "error", summary: firstLine(e.message) });
      return errorResult([`Error ${e.code}: ${e.message}`, e.fix ? `Fix: ${e.fix}` : "", e.next ? `Next: ${e.next}` : ""].filter(Boolean).join("\n"));
    }
    onEvent({ type: "tool", name: block.name, status: "error", summary: "Haggle server unreachable" });
    return errorResult(`The Haggle server couldn't be reached (${e instanceof Error ? e.message : String(e)}). Tell the user and suggest trying again shortly.`);
  }
}

const LABELS: Record<string, string> = {
  deal: "Starting deal", wait_for_update: "Checking for updates", get_quotes: "Reading quotes", list_deals: "Listing deals",
  get_conversation: "Reading conversation", answer_business: "Answering business", send_message: "Sending message",
  negotiate: "Negotiating", cancel_deal: "Cancelling deal", ask: "Estimating", discover: "Finding businesses",
  business_profile: "Reading business profile", check_price: "Checking price", get_identity: "Reading settings",
};
function startSummary(name: string, input: Record<string, unknown>): string {
  if (name === "deal" && input.dry_run === true) return "Previewing who would be contacted";
  return LABELS[name] ?? name;
}
function doneSummary(name: string, input: Record<string, unknown>, text: string, jobId?: string): string {
  if (name === "deal" && input.dry_run === true) return "Preview ready (nothing sent)";
  if (jobId) return `Deal ${jobId} started`;
  return firstLine(text) || "Done";
}

/** Closes any tool_use left without a result (cap reached, cut off), so the stored history stays valid. */
function closeDanglingToolUses(messages: MessageParam[], reason: string): void {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return;
  const uses = (last.content as { type: string; id?: string }[]).filter((b) => b.type === "tool_use" && b.id);
  if (!uses.length) return;
  messages.push({ role: "user", content: uses.map((b) => ({ type: "tool_result" as const, tool_use_id: b.id!, is_error: true, content: reason })) });
}

export async function runChatTurn(opts: RunChatTurnOptions): Promise<ChatTurnResult> {
  const { anthropic, haggle, history, onEvent, signal } = opts;
  const model = opts.model ?? DEFAULT_CHAT_MODEL;
  const maxCalls = opts.maxModelCalls ?? MAX_MODEL_CALLS;
  const fresh: MessageParam[] = [userTurn(opts.userText, opts.today ?? new Date())];
  let jobId: string | undefined;

  try {
    const tools = await chatTools(haggle);
    const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: CHAT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }];
    for (let call = 0; call < maxCalls; call++) {
      const stream = anthropic.beta.messages.stream(
        {
          model, max_tokens: 16000, system, tools, messages: [...history, ...fresh],
          thinking: { type: "adaptive" }, output_config: { effort: "medium" },
          betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
        },
        signal ? { signal } : undefined,
      );
      stream.on("text", (delta) => onEvent({ type: "text", delta }));
      const message = await stream.finalMessage();

      if (message.stop_reason === "refusal") {
        // The declined reply is not kept (the next turn starts from the last good state).
        onEvent({ type: "error", message: "Claude declined to answer this request. Try rephrasing it." });
        break;
      }
      // Appended unchanged (thinking blocks included) so the next request can continue it.
      fresh.push({ role: "assistant", content: message.content as unknown as ContentBlockParam[] });

      if (message.stop_reason === "tool_use") {
        if (call + 1 >= maxCalls) {
          // No model call is left to read the results: don't run tools (some act on the world).
          closeDanglingToolUses(fresh, "Not run: this turn reached its step limit.");
          onEvent({ type: "error", message: `Stopped after ${maxCalls} steps in one turn. Send another message to continue.` });
          break;
        }
        const uses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        const results: ToolResultBlockParam[] = [];
        for (const u of uses) {
          const out = await runTool(haggle, u, onEvent, signal);
          results.push(out.result);
          if (out.jobId) jobId = out.jobId;
        }
        // Every tool_result in ONE user message.
        fresh.push({ role: "user", content: results });
        continue;
      }
      if (message.stop_reason === "pause_turn") {
        if (call + 1 >= maxCalls) onEvent({ type: "error", message: `Stopped after ${maxCalls} steps in one turn. Send another message to continue.` });
        continue;
      }
      if (message.stop_reason === "max_tokens") {
        closeDanglingToolUses(fresh, "Not run: the reply was cut off.");
        onEvent({ type: "error", message: "The reply hit its length limit. Ask to continue." });
      }
      break; // end_turn, stop_sequence, max_tokens and anything else
    }
  } catch (e) {
    closeDanglingToolUses(fresh, "Not run: the turn was interrupted.");
    if (!isAbort(e, signal)) onEvent({ type: "error", message: errorMessage(e) });
    return { messages: fresh, ...(jobId ? { jobId } : {}) };
  }
  onEvent({ type: "done" });
  return { messages: fresh, ...(jobId ? { jobId } : {}) };
}

function errorMessage(e: unknown): string {
  if (e instanceof HaggleError) return `Haggle: ${e.message} ${e.fix}`.trim();
  const status = (e as { status?: number }).status;
  if (status === 401) return "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.";
  if (status === 429 || status === 529) return "Claude is busy right now. Try again in a minute.";
  return `Something went wrong talking to Claude${status ? ` (HTTP ${status})` : ""}. Try again.`;
}
