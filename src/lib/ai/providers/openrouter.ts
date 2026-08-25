import "server-only";
import { aiConfig } from "../config";
import { runConversationLoop } from "../loop";
import { getToolDefinitions } from "../tools/index";
import { AiProviderError } from "../provider-error";
import {
  toOpenRouterTools,
  toOpenRouterMessages,
  appendAssistantMessage,
  appendToolResultMessage,
  appendUserMessage,
  parseOpenRouterResponse,
  type OpenRouterChatResponse,
  type OpenRouterMessage,
} from "./openrouter-mapping";
import {
  hasAuthoritativeMenuFactSource,
  MENU_FACT_CORRECTIVE_INSTRUCTION,
} from "../tools/menu-fact-detection";
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

      const tools = toOpenRouterTools(getToolDefinitions());
      const initialMessages = toOpenRouterMessages(
        turn.system,
        turn.history,
        turn.userMessage,
      );

      return runConversationLoop<OpenRouterMessage[]>({
        initialMessages,
        maxToolCalls: turn.maxToolCalls,
        callModel: async (messages) => {
          let response: Response;
          try {
            response = await fetch(OPENROUTER_ENDPOINT, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://ai-waiter.local",
                "X-Title": "AI Waiter",
              },
              body: JSON.stringify({
                model: aiConfig.model,
                max_tokens: aiConfig.maxOutputTokens,
                messages,
                tools,
              }),
              signal: AbortSignal.timeout(aiConfig.requestTimeoutMs),
            });
          } catch (error) {
            // AbortSignal.timeout() firing rejects fetch with a
            // DOMException named "TimeoutError" — anything else here is a
            // genuine network-level failure (DNS, connection refused),
            // never an HTTP error (those reach the response.ok check below
            // instead, with the real status code).
            if (error instanceof Error && error.name === "TimeoutError") {
              throw new AiProviderError(
                `OpenRouter request timed out after ${aiConfig.requestTimeoutMs}ms`,
                "timeout",
              );
            }
            throw new AiProviderError(
              `OpenRouter request failed: ${error instanceof Error ? error.message : "network error"}`,
              "network_error",
            );
          }

          if (!response.ok) {
            throw new AiProviderError(
              `OpenRouter request failed: ${response.status} ${response.statusText}`,
              response.status === 429 ? "rate_limited" : "http_error",
            );
          }

          let json: OpenRouterChatResponse;
          try {
            json = (await response.json()) as OpenRouterChatResponse;
          } catch (error) {
            throw new AiProviderError(
              `OpenRouter returned a malformed response: ${error instanceof Error ? error.message : "parse error"}`,
              "unknown",
            );
          }
          return parseOpenRouterResponse(json);
        },
        callTool: turn.callTool,
        appendAssistantMessage,
        appendToolResultMessage,
        textAcceptanceGuard: turn.requiresAuthoritativeMenuSource
          ? {
              shouldAccept: hasAuthoritativeMenuFactSource,
              correctiveInstruction: MENU_FACT_CORRECTIVE_INSTRUCTION,
              appendUserMessage,
            }
          : undefined,
      });
    },
  };
}
