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
   * The WAITER's list — holding a conversation and calling tools. Ordered
   * preference: OpenRouter serves the first that answers, so a model
   * hitting its free-tier rate limit degrades to the next instead of
   * taking the waiter down.
   *
   * EVERY ENTRY HERE HAS HELD A REAL CONVERSATION IN THIS APP. That bar
   * exists because an automated probe could not see the two failures that
   * disqualified the two fastest candidates on 2026-09-05:
   *
   *   nvidia/nemotron-3-super-120b-a12b:free  probe 4/4, 240ms
   *     Live: dumped its chain-of-thought to the customer AND quoted the
   *     system prompt back, including the factuality guard's internal
   *     corrective note. A diner asking "what do you recommend?" got
   *     paragraphs of the model arguing with its own instructions. It
   *     scored 4/4 because it does call the tool — it just narrates the
   *     deliberation into the reply.
   *
   *   nvidia/nemotron-3.5-lightning:free      probe 4/4, 299ms
   *     Live: zero tool calls, guard exhausted, 54 SECONDS. The probe
   *     measured 299ms because it asked one short question with a one-line
   *     system prompt; the real prompt is long and layered, and this model
   *     falls apart on it.
   *
   *   nvidia/nemotron-3-ultra-550b-a55b:free  probe 1/4
   *     Removed on the probe alone — it was a shipping fallback that
   *     answered three of four menu questions without calling anything.
   *
   * The lesson is in the ordering: latency measured on a toy prompt is not
   * latency, and "calls a tool" is not "is a waiter". Speed rankings
   * favour small models, and small models are where conversational
   * quality and instruction-following collapse.
   *
   * Both survivors are vendor-distinct (dots-studio, MiniMax), since two
   * models behind one provider tend to fail together.
   */
  openrouter: [
    // Live 2026-09-05: 2 tool calls, 24s, real dishes at the right prices
    // in the right currency, and it closed by asking what the customer was
    // in the mood for — the behaviour the prompt asks for.
    "dots-studio/dots-3-note-preview:free",
    // The incumbent, and the only model with a long track record here:
    // every live waiter turn during this feature's development was served
    // by it, including the preparation, portion and spice conversations.
    "minimax/minimax-m3:free",
  ],
};

/**
 * The MENU-PHOTO READER's list — one image in, JSON out, no tools.
 *
 * A different job with a different failure mode: not "did it call a tool"
 * but "did it invent a price". Vetted 2026-09-05 by
 * scripts/vet-models-by-job.ts (job: vision) against
 * tests/fixtures/menu-board.jpg — a deliberately degraded photograph
 * (rotated, lit from one side, slightly out of focus, lossy JPEG) whose
 * last line reads "Market price today - ask at counter" and must come back
 * with a null price.
 *
 *   nvidia/nemotron-3-nano-omni…:free      12/12   568ms
 *   minimax/minimax-m3:free                12/12  1103ms
 *   dots-studio/dots-3-note-preview:free   12/12  1122ms
 *
 * All three read every price and none invented one for the trap line.
 * Three is the whole list, not a top-five cut: OpenRouter has seven free
 * vision models, two are access-gated (403) and two rate-limit on every
 * attempt.
 */
export const DEFAULT_VISION_MODELS = [
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "minimax/minimax-m3:free",
  "dots-studio/dots-3-note-preview:free",
];

/**
 * The SUGGESTER's list — dish names in, structured JSON out, no images and
 * no tools.
 *
 * Until now this job borrowed the vision model, because the code sat next
 * to it — an accident, not a decision, and the call contains no image at
 * all. It is also the job with the strictest correctness bar in the app,
 * since it proposes allergens.
 *
 * Vetted 2026-09-05 by scripts/vet-models-by-job.ts (job: suggestion):
 * five dishes must all come back, each with ingredients, every allergen
 * inside the fixed vocabulary and every spice level on the fixed ladder.
 *
 *   nvidia/nemotron-3-nano-omni…:free       5/5   224ms
 *   z-ai/glm-5.2:free                       5/5   242ms
 *   nvidia/nemotron-3-super-120b-a12b:free  5/5   284ms
 *   cohere/north-mini-code:free             5/5   532ms
 *   dots-studio/dots-3-note-preview:free    5/5   777ms
 *
 * dots-3 is kept last rather than dropped: it is the model that actually
 * produced Nashta's 153 descriptions, portion notes and spice levels, so
 * it is the one entry here with a real corpus behind it.
 *
 * liquid/lfm-2.5-2.6b and nvidia/nemotron-3.5-lightning both FAILED with
 * malformed JSON despite passing the waiter job — the clearest evidence
 * that these lists have to be separate.
 */
export const DEFAULT_SUGGESTION_MODELS = [
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "z-ai/glm-5.2:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "cohere/north-mini-code:free",
  "dots-studio/dots-3-note-preview:free",
];

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
   * The menu-photo reader's preference list. Its own env var, because it
   * is its own job — see DEFAULT_VISION_MODELS above.
   */
  visionModels: envList("MENU_IMPORT_VISION_MODEL", DEFAULT_VISION_MODELS),

  /**
   * The detail-suggester's preference list. Likewise its own env var; this
   * job used to borrow the vision model despite sending no image.
   */
  suggestionModels: envList("MENU_SUGGESTION_MODEL", DEFAULT_SUGGESTION_MODELS),

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
