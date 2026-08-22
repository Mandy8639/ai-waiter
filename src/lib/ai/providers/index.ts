import "server-only";
import { aiConfig } from "../config";
import { createAnthropicProvider } from "./anthropic";
import { createOpenRouterProvider } from "./openrouter";
import type { AiProvider } from "./types";

/**
 * Selects the one provider aiConfig.provider names (AI_PROVIDER env var —
 * see config.ts) and returns it only if THAT provider's own secret is
 * configured — never constructs or checks the other provider at all, so
 * AI_PROVIDER=openrouter never requires ANTHROPIC_API_KEY and vice versa
 * (spec requirements 10/11). Lazily cached the same way
 * providers/anthropic.ts's own client is, and for the same reason: unset
 * means "AI disabled," not a fatal startup error — the AI waiter is
 * always an optional enhancement layer, never a dependency of ordinary
 * ordering, regardless of which provider is selected.
 */
let cachedProvider: AiProvider | null | undefined;

export function getAiProvider(): AiProvider | null {
  if (cachedProvider !== undefined) return cachedProvider;

  const candidate: AiProvider =
    aiConfig.provider === "openrouter"
      ? createOpenRouterProvider()
      : createAnthropicProvider();

  cachedProvider = candidate.isConfigured() ? candidate : null;
  return cachedProvider;
}

/** True if the AI waiter can be offered at all — used by both the server action and the UI to decide whether to show the entry point. */
export function isAiConfigured(): boolean {
  return getAiProvider() !== null;
}

export type { AiProvider, AiConversationTurn } from "./types";
