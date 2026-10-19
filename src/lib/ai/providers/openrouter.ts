import "server-only";
import { aiConfig } from "../config";
import { getModelsFor } from "../model-settings";
import { runConversationLoop } from "../loop";
import { getToolDefinitions } from "../tools/index";
import { callOpenRouterModel } from "./openrouter-model-call";
import {
  toOpenRouterTools,
  toOpenRouterMessages,
  appendAssistantMessage,
  appendToolResultMessage,
  appendUserMessage,
  type OpenRouterMessage,
} from "./openrouter-mapping";
import { buildTextAcceptanceGuards } from "./text-acceptance-guards";
import type { AiProvider, AiConversationTurn } from "./types";

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/**
 * The development provider (Batch 9): OpenRouter's OpenAI-compatible Chat
 * Completions API, so local development never needs a paid ANTHROPIC_API_KEY.
 * Selected via AI_PROVIDER=openrouter; requires OPENROUTER_API_KEY only —
 * never touches ANTHROPIC_API_KEY, matching the production provider's own
 * "never require the other provider's secret" contract. See
 * docs/ai.md#provider-and-configuration for the selected free model and
 * why.
 *
 * Uses `fetch` directly rather than an SDK — OpenRouter's API is a plain
 * HTTP-compatible surface, and this app already has no other HTTP client
 * dependency to reuse, so a new SDK dependency would add weight for a
 * single endpoint this file already fully covers.
 */
export function createOpenRouterProvider(): AiProvider {
  return {
    name: "openrouter",

    isConfigured(): boolean {
      return !!process.env.OPENROUTER_API_KEY;
    },

    async runTurn(turn: AiConversationTurn) {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error("OpenRouter provider is not configured.");
      }

      // Resolved once per turn, so every call in this turn's tool loop
      // asks the same models (saved on /admin, else AI_MODEL, else default).
      const { models } = await getModelsFor("waiter");

      const tools = toOpenRouterTools(getToolDefinitions());
      const initialMessages = toOpenRouterMessages(
        turn.system,
        turn.history,
        turn.userMessage,
      );

      return runConversationLoop<OpenRouterMessage[]>({
        initialMessages,
        maxToolCalls: turn.maxToolCalls,
        callModel: (messages) =>
          callOpenRouterModel({
            endpoint: OPENROUTER_ENDPOINT,
            apiKey,
            model: models[0],
            fallbackModels: models.slice(1),
            maxOutputTokens: aiConfig.maxOutputTokens,
            requestTimeoutMs: aiConfig.requestTimeoutMs,
            messages,
            tools,
          }),
        callTool: turn.callTool,
        appendAssistantMessage,
        appendToolResultMessage,
        textAcceptanceGuards: buildTextAcceptanceGuards({
          requiresAuthoritativeMenuSource: turn.requiresAuthoritativeMenuSource,
          requiresAllergenSource: turn.requiresAllergenSource,
          appendUserMessage,
        }),
      });
    },
  };
}
