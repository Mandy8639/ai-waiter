import type { ConversationMessage } from "./conversation";

/**
 * Cross-turn conversational history replayed to the model — user/assistant
 * turns only ('tool' rows are this codebase's own audit log, not part of
 * any provider's message structure). Deliberately factored out of
 * orchestrator.ts (which has `import "server-only"` and talks to the real
 * database) so this is unit-testable without a live model or database —
 * same rationale as loop.ts.
 */
export function buildHistoryMessages(
  history: ConversationMessage[],
): Array<{ role: "user" | "assistant"; content: string }> {
  return history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
}

const RECENT_TOOL_CONTEXT_LIMIT = 3;

/**
 * A bounded summary of the most recent successful tool calls in this
 * conversation, meant to be appended to the system prompt — not mixed
 * into the user/assistant history array, since it isn't something either
 * of them said. Cross-turn history previously carried only user/assistant
 * text, so a tool result discovered in one turn (e.g. a menu item's
 * modifier groups) was silently gone by the next turn, once that turn's
 * own in-memory conversation was discarded (see docs/ai.md — Phase 2A
 * Turn-3 investigation). Only successful calls; only the trailing window,
 * oldest-of-the-window first, so the model reads them in the order they
 * actually happened. Deliberately bounded, not a full session/order state
 * machine — this fixes the reported multi-turn context loss without
 * introducing new persistence.
 */
export function buildRecentToolContext(
  history: ConversationMessage[],
): string | undefined {
  const recentSuccesses = history
    .filter(
      (m): m is ConversationMessage & { toolName: string } =>
        m.role === "tool" && m.toolSuccess === true && m.toolName !== null,
    )
    .slice(-RECENT_TOOL_CONTEXT_LIMIT);

  if (recentSuccesses.length === 0) return undefined;

  return recentSuccesses.map((m) => `- ${m.toolName}: ${m.content}`).join("\n");
}
