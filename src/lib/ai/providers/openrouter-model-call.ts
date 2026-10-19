import { openRouterModels } from "../model-list";
import type { LoopModelResponse } from "../loop";
import { AiProviderError } from "../provider-error";
import { USAGE_REQUEST } from "../usage-core";
import {
  parseOpenRouterResponse,
  type OpenRouterChatResponse,
  type OpenRouterMessage,
  type OpenRouterTool,
} from "./openrouter-mapping";

export interface OpenRouterModelCallParams {
  endpoint: string;
  apiKey: string;
  model: string;
  /**
   * Additional models to try, in order, if `model` can't serve the request
   * — see docs/ai.md#model-fallback. Empty for a single-model config.
   */
  fallbackModels?: string[];
  maxOutputTokens: number;
  requestTimeoutMs: number;
  messages: OpenRouterMessage[];
  tools: OpenRouterTool[];
  /** Sees each successful reply's body, for its usage and cost (src/lib/ai/usage-core.ts). */
  onReply?: (body: OpenRouterChatResponse) => void;
}

/**
 * Extracted from providers/openrouter.ts (no `server-only` import here,
 * and `endpoint` is a parameter rather than the hardcoded production
 * constant) so this — including the real `fetch` call and real
 * `AbortSignal.timeout` — is directly, empirically testable: point
 * `endpoint` at a local HTTP server that hangs/errors/responds slowly and
 * observe the real timeout/error classification fire, rather than only
 * unit-testing the classification logic against a mocked error object.
 * See tests/unit/ai-provider-openrouter-model-call.test.ts.
 */
export async function callOpenRouterModel(
  params: OpenRouterModelCallParams,
): Promise<LoopModelResponse> {
  const fallbackModels = params.fallbackModels ?? [];
  let response: Response;
  try {
    response = await fetch(params.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://tableside.menu",
        "X-Title": "Tableside",
      },
      body: JSON.stringify({
        // OpenRouter routes across a preference list via `models`, serving
        // the first entry that can answer. Critically, `model` and
        // `models` must NEVER both be sent: the singular field wins and
        // the fallback list is silently ignored — verified live against
        // the real API, where a dead primary + healthy fallback returned
        // 429 with both fields set and succeeded with only `models`.
        ...(fallbackModels.length > 0
          ? { models: openRouterModels([params.model, ...fallbackModels]) }
          : { model: params.model }),
        max_tokens: params.maxOutputTokens,
        messages: params.messages,
        tools: params.tools,
        ...USAGE_REQUEST,
      }),
      signal: AbortSignal.timeout(params.requestTimeoutMs),
    });
  } catch (error) {
    // AbortSignal.timeout() firing rejects fetch with a DOMException named
    // "TimeoutError" — anything else here is a genuine network-level
    // failure (DNS, connection refused), never an HTTP error (those reach
    // the response.ok check below instead, with the real status code).
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new AiProviderError(
        `OpenRouter request timed out after ${params.requestTimeoutMs}ms`,
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
  params.onReply?.(json);
  return parseOpenRouterResponse(json);
}
