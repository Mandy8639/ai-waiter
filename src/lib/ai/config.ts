import "server-only";
import { envInt, envList } from "@/lib/env-helpers";

/**
 * Centralized AI configuration — every tunable in one place, read from
 * environment variables with sensible defaults, rather than scattered
 * magic numbers across the orchestrator/tools/UI (spec section 28).
 *
 * Nothing here is a secret (the API key lives in `client.ts`, validated
 * lazily and only where it's actually used — same pattern as
 * `src/lib/supabase/admin.ts`).
 */

export type AiProviderName = "anthropic" | "openrouter";

/**
 * Batch 9: which backend actually serves AI turns. `anthropic` (the
 * production default) requires ANTHROPIC_API_KEY; `openrouter` (a
 * cost-free development alternative — see src/lib/ai/providers/) requires
 * OPENROUTER_API_KEY instead. Neither provider ever requires the other's
 * key — see src/lib/ai/providers/index.ts.
 */
const provider: AiProviderName =
  process.env.AI_PROVIDER === "openrouter" ? "openrouter" : "anthropic";

/**
 * Each provider ships its own default model, so AI_PROVIDER=openrouter
 * works out of the box with no AI_MODEL configured — a free,
 * tool-calling-capable model, not a placeholder that needs tuning before
 * dev even starts. See docs/ai.md#provider-and-configuration for why this
 * specific OpenRouter model was chosen.
 *
 * The OpenRouter default was google/gemma-4-26b-a4b-it:free until
 * 2026-09-03, when it was changed because that model had stopped serving:
 * it returns 429 ("temporarily rate-limited upstream" from Google AI
 * Studio) on every attempt, which defeated the entire point of shipping a
 * default that works untuned. Never pick "openrouter/free" here — it is a
 * router alias that resolves to a different model per request, so its
 * tool-calling reliability cannot be characterized, and in production it
 * routed to a model that reported adding an item to the cart without ever
 * calling add_item_to_cart.
 */
const defaultModelsByProvider: Record<AiProviderName, string[]> = {
  anthropic: ["claude-opus-5"],
  /**
   * An ordered preference list, not just a default: OpenRouter accepts a
   * `models` array and transparently serves the first one that answers, so
   * a free model hitting its provider's rate limit (or being delisted, as
   * google/gemma-4-26b-a4b-it:free was) degrades to the next instead of
   * taking the AI waiter down. Both entries were vetted by running this
   * app's own tool sequence and checking the model actually emitted
   * add_item_to_cart before claiming the item was added — see
   * docs/ai.md#model-fallback. Deliberately different vendors (MiniMax,
   * NVIDIA), since two models behind one provider tend to fail together.
   *
   * Only add a model here after it passes that same check. An unvetted
   * entry reintroduces exactly the failure the curated list exists to
   * prevent: see tools/cart-fact-detection.ts for what a model that
   * fabricates tool calls does to a customer's order.
   *
   * Re-vetted 2026-09-05 with scripts/vet-openrouter-models.ts, which
   * runs that check as four questions answerable only by a tool call:
   *
   *   minimax/minimax-m3:free                4/4
   *   nvidia/nemotron-3-ultra-550b-a55b:free 4/4
   *   dots-studio/dots-3-note-preview:free   4/4  (added)
   *   poolside/laguna-s-2.1:free             3/4  REJECTED
   *
   * dots-3 was added as a third vendor because the failure this list
   * exists for actually happened again — a 429 mid-session — and two
   * entries is thin cover. It is already this app's menu-import vision
   * model, so it is a known quantity.
   *
   * laguna-s is rejected, and instructively: it answered every factual
   * question with a tool call and then answered "What do you recommend?"
   * from nothing. A model can be reliable on the questions that look hard
   * and fail on the one that looks easy, which is why the probe set
   * includes it.
   */
  openrouter: [
    "minimax/minimax-m3:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "dots-studio/dots-3-note-preview:free",
  ],
};

export const aiConfig = {
  provider,

  /**
   * Update the Anthropic default as Anthropic's current recommended model
   * changes — kept as one named constant (overridable via env) rather than
   * repeated inline, so upgrading the model is a one-line change, not a
   * grep. `claude-opus-5` is the current Anthropic default; sampling
   * params (temperature/top_p/top_k) are removed on this model, so there
   * is deliberately no `temperature` setting here — see
   * providers/anthropic.ts.
   */
  /**
   * The primary model — first entry of the resolved preference list.
   * Anthropic uses only this one; OpenRouter sends the whole list.
   */
  model: envList("AI_MODEL", defaultModelsByProvider[provider])[0],

  /**
   * The rest of the preference list, in order, or [] when only one model
   * is configured. `AI_MODEL` accepts a comma-separated list for this;
   * a single value behaves exactly as it always has.
   */
  modelFallbacks: envList("AI_MODEL", defaultModelsByProvider[provider]).slice(
    1,
  ),

  /**
   * Anthropic-only: Claude Opus 5 has adaptive thinking on by default;
   * disabling it has documented failure modes (tool calls/`<thinking>`
   * leaking into visible text). Cost/latency is controlled via output
   * effort instead — "low" is the recommended starting point for
   * chat-style workloads like this one. Unused when provider ===
   * "openrouter" (harmless — providers/openrouter.ts never reads it).
   */
  effort:
    (process.env.AI_EFFORT as "low" | "medium" | "high" | "xhigh" | "max") ||
    "low",

  maxOutputTokens: envInt("AI_MAX_OUTPUT_TOKENS", 1024),

  /** Per-request timeout to the model provider. */
  requestTimeoutMs: envInt("AI_REQUEST_TIMEOUT_MS", 20_000),

  /** Transient-failure retries (network/5xx/overloaded) — not retried on invalid-request errors. */
  maxProviderRetries: envInt("AI_MAX_PROVIDER_RETRIES", 2),

  /**
   * Cost/loop control (spec section 26): a single customer turn can chain
   * multiple tool calls (e.g. search_menu -> get_menu_item -> add_item_to_cart),
   * but never unboundedly — this is the hard ceiling the orchestrator
   * enforces regardless of what the model tries to do.
   */
  maxToolCallsPerTurn: envInt("AI_MAX_TOOL_CALLS_PER_TURN", 6),

  /** How many past messages (both roles) are sent back to the model as context — bounds token usage, not just history length. */
  maxHistoryMessages: envInt("AI_MAX_HISTORY_MESSAGES", 20),

  /** Customer message length cap, in characters — rejected before it ever reaches the model. */
  maxInputLength: envInt("AI_MAX_INPUT_LENGTH", 2000),

  /**
   * Session-scoped rate limit (spec section 27): counts this customer
   * session's own 'user'-role messages in the trailing window — never IP
   * address, which isn't a meaningful identity boundary for a shared
   * restaurant Wi-Fi network and isn't available to a request this deep
   * in the stack without extra plumbing anyway. See
   * src/lib/ai/rate-limit.ts.
   */
  rateLimit: {
    maxMessagesPerWindow: envInt("AI_RATE_LIMIT_MAX_MESSAGES", 20),
    windowMinutes: envInt("AI_RATE_LIMIT_WINDOW_MINUTES", 10),
  },
} as const;
