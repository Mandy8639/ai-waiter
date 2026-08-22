import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { aiConfig } from "../config";
import { runConversationLoop } from "../loop";
import { getToolDefinitions } from "../tools/index";
import {
  toAnthropicTools,
  toAnthropicMessages,
  appendAssistantMessage,
  appendToolResultMessage,
  parseAnthropicResponse,
} from "./anthropic-mapping";
import type { AiProvider, AiConversationTurn } from "./types";

/**
 * The production provider — unchanged behavior from Batch 7/8, just moved
 * out of client.ts/orchestrator.ts into this provider module. Still the
 * beta Messages endpoint (server-side refusal fallbacks), still adaptive
 * thinking, still output_config.effort, still no sampling parameters
 * (Claude Opus 5 rejects them) — see docs/ai.md#provider-and-configuration.
 *
 * Deliberately does NOT throw when ANTHROPIC_API_KEY is missing — the AI
 * waiter must be an optional enhancement layer regardless of which
 * provider is selected (spec section 32/46). `isConfigured()` returns
 * false instead, so the provider factory (./index.ts) reports this
 * provider unavailable rather than crashing a request.
 */
let cachedClient: Anthropic | null | undefined;

function getClient(): Anthropic | null {
  if (cachedClient !== undefined) return cachedClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    cachedClient = null;
    return null;
  }
  cachedClient = new Anthropic({
    apiKey,
    timeout: aiConfig.requestTimeoutMs,
    maxRetries: aiConfig.maxProviderRetries,
  });
  return cachedClient;
}

export function createAnthropicProvider(): AiProvider {
  return {
    name: "anthropic",

    isConfigured(): boolean {
      return getClient() !== null;
    },

    async runTurn(turn: AiConversationTurn) {
      const client = getClient();
      if (!client) {
        throw new Error("Anthropic provider is not configured.");
      }

      const tools = toAnthropicTools(getToolDefinitions());
      const initialMessages = toAnthropicMessages(
        turn.history,
        turn.userMessage,
      );

      return runConversationLoop({
        initialMessages,
        maxToolCalls: turn.maxToolCalls,
        callModel: async (messages) => {
          const response = await client.beta.messages.create({
            model: aiConfig.model,
            max_tokens: aiConfig.maxOutputTokens,
            system: turn.system,
            tools,
            messages,
            thinking: { type: "adaptive" },
            output_config: { effort: aiConfig.effort },
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
          });
          return parseAnthropicResponse(response);
        },
        callTool: turn.callTool,
        appendAssistantMessage,
        appendToolResultMessage,
      });
    },
  };
}
