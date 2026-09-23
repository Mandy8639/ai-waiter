/**
 * The interface every AI image generator is written against, and the
 * configuration that decides whether one exists at all.
 *
 * NO `server-only` HERE. Everything in this file is pure or interface-only
 * so the tests can import it directly — see src/lib/env-helpers.ts for why
 * a `server-only` import makes a module untestable in this project.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE. docs/MENU_PHOTO_STRATEGY.md §18
 * decision 1: AI image generation must cost $0. There is no paid model, no
 * paid fallback, no credits, and — the part that shapes the code — **never
 * an automatic switch to another model**. That last clause is why this
 * module has a single `model` and not the ordered preference list the
 * waiter uses (src/lib/ai/config.ts). A waiter that silently degrades to
 * the next free model still answers the diner. An image generator that
 * silently degrades might bill the restaurant, so when the configured
 * model cannot serve, the only correct behaviour is to stop and say so.
 *
 * WHY THIS SHIPS DISABLED. Re-checked against OpenRouter on 2026-09-23,
 * as §18 instructed:
 *
 *   GET /api/v1/images/models                             ->  54 models, none free
 *   GET /api/v1/models/recraft/recraft-v3:free/endpoints  ->  "endpoints": []
 *
 * Not one of the 54 has a `:free` variant. The cheapest observed was
 * recraft/recraft-v4.1-flash at $0.007 per image — which, against the
 * existing cap of 10 attempts per restaurant per day, would be at most
 * about $2 per restaurant per month. That number is recorded here so the
 * decision to turn this on is an informed one rather than a guess.
 *
 * So the approved zero-cost model still has no provider serving it, four
 * days after the same check failed. With `MENU_IMAGE_MODEL` unset — the
 * default, and what production runs — `configuredModel()` returns null,
 * every entry point reports UNCONFIGURED, and not one request is ever
 * made. The pipeline below is complete and tested against a fake provider;
 * turning it on is one environment variable on the day a free model
 * appears, or the day someone decides to pay.
 */

/** What the generator was asked to draw, already reduced to text. */
export interface GenerationRequest {
  prompt: string;
  /** Wired to AbortSignal.timeout by the implementation. */
  timeoutMs: number;
}

/** What came back. `bytes` still has to survive processing.ts like any upload. */
export interface GeneratedImage {
  bytes: Buffer;
  /** Recorded on the image row; the database refuses an AI image without both. */
  provider: string;
  model: string;
}

/**
 * Why a generator cannot run right now. Every value is a state an owner
 * can be told about without leaking configuration.
 */
export type UnavailableReason =
  /** No MENU_IMAGE_MODEL. The normal state of production today. */
  | "UNCONFIGURED"
  /** Configured, but the key it needs is absent. A deployment mistake. */
  | "NO_API_KEY"
  /** The model exists but no provider serves it — recraft-v3:free's state. */
  | "NO_ENDPOINTS"
  /** The provider said no, for now: 429, 5xx, timeout. */
  | "PROVIDER_UNAVAILABLE";

/**
 * Thrown when generation cannot even be attempted, as distinct from an
 * attempt that failed. The difference is not cosmetic: an attempt consumes
 * a slot from the daily quota because it may have been billed, whereas
 * "there is no model configured" must never cost a restaurant an attempt.
 * generation-core.ts reserves the quota slot only after availability has
 * been established.
 */
export class GenerationUnavailable extends Error {
  constructor(
    readonly reason: UnavailableReason,
    message = "AI image generation is temporarily unavailable.",
  ) {
    super(message);
    this.name = "GenerationUnavailable";
  }
}

/**
 * Thrown when a request was made and did not produce a usable image. The
 * attempt counts; §18 decision 4 counts attempts, not successes, precisely
 * because a failed call can still be a billed call.
 */
export class GenerationFailed extends Error {
  constructor(message = "The image could not be generated.") {
    super(message);
    this.name = "GenerationFailed";
  }
}

export interface ImageGenerationProvider {
  /** Stable identifier recorded on the image row, e.g. "openrouter". */
  readonly name: string;
  /**
   * Cheap, read-only check that this provider could serve a request now.
   * Throws GenerationUnavailable rather than returning false so the reason
   * survives; nothing else distinguishes "no model" from "model is down",
   * and the owner-facing copy differs.
   */
  preflight(): Promise<void>;
  generate(request: GenerationRequest): Promise<GeneratedImage>;
}

/**
 * Just enough of the environment to read a setting. Not NodeJS.ProcessEnv:
 * that type demands the whole ambient environment, so a test could not
 * hand these functions a two-key object without an `unknown` cast — and a
 * cast is exactly the thing that would hide a typo in a variable name.
 */
export type EnvLike = Record<string, string | undefined>;

/**
 * The single model, or null when none is configured.
 *
 * Deliberately not `envList`: a list would be a fallback chain, and a
 * fallback chain is the automatic model switch decision 1 forbids. If
 * someone sets a comma-separated value here, they get a model id with a
 * comma in it, which OpenRouter will reject — a loud failure, which is the
 * right outcome for a setting that must not be a list.
 */
export function configuredModel(env: EnvLike = process.env): string | null {
  const raw = env.MENU_IMAGE_MODEL?.trim();
  return raw ? raw : null;
}

/** How long a single generation request may take before it is abandoned. */
export function generationTimeoutMs(env: EnvLike = process.env): number {
  const raw = Number.parseInt(env.MENU_IMAGE_TIMEOUT_MS ?? "", 10);
  // 120s default: image models are slow, and the database's own
  // generation_timeout_seconds (180s) must stay the outer bound, so a
  // request that hangs is abandoned here first and the row is failed
  // properly rather than being swept up later as a stale generation.
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

/**
 * Whether the feature can be offered, without making a network call.
 * The owner UI uses this to decide between a working button and a disabled
 * one with an explanation, so it must never throw.
 */
export function generationConfigured(
  env: EnvLike = process.env,
): { available: false; reason: UnavailableReason } | { available: true } {
  if (!configuredModel(env)) {
    return { available: false, reason: "UNCONFIGURED" };
  }
  if (!env.OPENROUTER_API_KEY?.trim()) {
    return { available: false, reason: "NO_API_KEY" };
  }
  return { available: true };
}

/**
 * What an owner is told. Every reason maps to the same sentence §18
 * decision 1 specifies, because the distinctions above are operational,
 * not something a restaurant can act on. Kept as a function rather than a
 * constant so a future reason cannot be added without visiting this map.
 */
export function unavailableMessage(reason: UnavailableReason): string {
  switch (reason) {
    case "UNCONFIGURED":
    case "NO_API_KEY":
    case "NO_ENDPOINTS":
    case "PROVIDER_UNAVAILABLE":
      return "AI image generation is temporarily unavailable.";
  }
}
