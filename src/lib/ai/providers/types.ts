import type { LoopToolOutcome, RunConversationLoopResult } from "../loop";

/**
 * The provider abstraction (Batch 9): the one seam between "talk to a
 * model" and everything else. Deliberately thin — `runTurn()`'s
 * parameters and return value are exactly what `runConversationLoop()`
 * (src/lib/ai/loop.ts) already needs/returns, so a provider's whole job is
 * to build a `callModel` closure for its own wire format and hand
 * everything else straight to the existing, unmodified, provider-agnostic
 * loop. No tool authorization, cart/order/pricing logic, or Supabase
 * access lives here or in any provider file — see
 * docs/ai.md#provider-and-configuration.
 */

export interface AiConversationTurn {
  /** Same content every provider gets — the system prompt built by system-prompt.ts, unchanged regardless of provider. */
  system: string;
  /** Prior user/assistant turns from ai_conversation_messages, oldest first — plain text, not yet in any provider's wire format. */
  history: Array<{ role: "user" | "assistant"; content: string }>;
  /** The new message being answered this turn. */
  userMessage: string;
  /** The hard per-turn tool-call ceiling (aiConfig.maxToolCallsPerTurn) — enforced by loop.ts regardless of provider. */
  maxToolCalls: number;
  /** Executes one tool call — always the same executeTool()-backed closure the orchestrator builds; a provider never sees tool implementation details. */
  callTool: (name: string, args: unknown) => Promise<LoopToolOutcome>;
}

export interface AiProvider {
  readonly name: "anthropic" | "openrouter";
  /** True only if this specific provider's own required secret is set — never checks the other provider's key (spec: neither provider requires the other's credential). */
  isConfigured(): boolean;
  runTurn(turn: AiConversationTurn): Promise<RunConversationLoopResult>;
}
