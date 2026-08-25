import Anthropic from "@anthropic-ai/sdk";

/**
 * A normalized error shape both providers throw, so orchestrator.ts can
 * log a meaningful category (spec section 38 observability) without
 * knowing anything about OpenRouter's plain fetch() errors or the
 * Anthropic SDK's own typed error classes — each provider translates its
 * own errors into this shape at the point it already knows the most
 * about what actually went wrong (a timeout, an HTTP status, a network
 * failure), rather than orchestrator.ts guessing from an opaque message
 * string after the fact.
 */
export type AiErrorCategory =
  "timeout" | "rate_limited" | "http_error" | "network_error" | "unknown";

export class AiProviderError extends Error {
  readonly category: AiErrorCategory;

  constructor(message: string, category: AiErrorCategory) {
    super(message);
    this.name = "AiProviderError";
    this.category = category;
  }
}

/** category if `error` is an AiProviderError, otherwise "unknown" — the safe fallback for anything a provider didn't (or couldn't) classify. */
export function categorizeAiError(error: unknown): AiErrorCategory {
  return error instanceof AiProviderError ? error.category : "unknown";
}

/**
 * Classifies an error thrown by the Anthropic SDK. No `server-only` import
 * in this file (unlike providers/anthropic.ts, which does have one) is
 * what keeps this directly unit-testable — importing the SDK's error
 * classes themselves is fine outside Next's bundler, only anthropic.ts's
 * own server-only guard isn't.
 *
 * Order matters: APIConnectionTimeoutError and RateLimitError both extend
 * a more general SDK error class (APIConnectionError and APIError
 * respectively), so the more specific check has to come first or it's
 * unreachable.
 */
export function categorizeAnthropicError(error: unknown): AiErrorCategory {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (error instanceof Anthropic.RateLimitError) return "rate_limited";
  if (error instanceof Anthropic.APIConnectionError) return "network_error";
  if (error instanceof Anthropic.APIError) return "http_error";
  return "unknown";
}
