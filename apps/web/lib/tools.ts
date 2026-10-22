// Which Haggle MCP tools the web app's LLM may call, and which only a signed-in human's click may
// trigger (through this app's own routes). CLAUDE.md §7: the model never approves, pays or rings a
// business on its own; in the web app those are buttons, never tool calls.
import type { HaggleClient } from "@/lib/haggle";

/** Tools the chat model may call (read, start, follow, message, negotiate, cancel). */
export const LLM_TOOLS = [
  "deal", "wait_for_update", "get_quotes", "list_deals", "get_conversation", "answer_business", "send_message",
  "negotiate", "cancel_deal", "ask", "discover", "business_profile", "check_price", "get_identity",
] as const;
export type LlmToolName = (typeof LLM_TOOLS)[number];

/**
 * Human-only: approving (the demo server would otherwise record a SIMULATED human's yes for a
 * client with no approval form), paying, authorizing a callback, and the board-button tools.
 */
export const HUMAN_ONLY_TOOLS = ["approve", "pay", "call_back", "choose_in_view", "approve_in_view", "call_back_in_view"] as const;

export const isLlmTool = (name: string): name is LlmToolName => (LLM_TOOLS as readonly string[]).includes(name);

/** The MCP tool list filtered to the allowlist, in a stable order (a stable prompt-cache prefix). */
export async function llmToolDefinitions(haggle: HaggleClient): Promise<{ name: LlmToolName; description: string; inputSchema: Record<string, unknown> }[]> {
  const tools = await haggle.listTools();
  return LLM_TOOLS.flatMap((name) => {
    const t = tools.find((x) => x.name === name);
    return t ? [{ name, description: t.description ?? "", inputSchema: t.inputSchema }] : [];
  });
}
