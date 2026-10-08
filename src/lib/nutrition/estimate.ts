import "server-only";
import { aiConfig } from "@/lib/ai/config";
import { isFreeModel } from "@/lib/translations/core";
import {
  estimatePrompt,
  parseEstimateReply,
  type EstimateDish,
  type Nutrition,
} from "./core";

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export type EstimateResult =
  | { ok: true; estimates: Map<string, Nutrition> }
  | { ok: false; reason: "not_free" | "not_configured" | "failed" };

/** Attempts per batch, and how long one batch may take across them. */
const MAX_ATTEMPTS = 3;
const BATCH_BUDGET_MS = 45_000;

/**
 * Asks the free model for rough nutrition estimates for one batch of
 * dishes (phase M). Drafts only: nothing here reaches a diner until a
 * person confirms it. Refuses outright unless the configured model is
 * free — the same rule as translation drafting.
 *
 * Retries, because the free router is uneven: in a live check on
 * 2026-10-08 the same request was answered in 1.5 s, in 44 s, not at all,
 * and once by a content-safety model that replied "User Safety: safe". A
 * reply with no usable estimate is treated like no reply.
 */
export async function estimateNutrition(
  dishes: EstimateDish[],
): Promise<EstimateResult> {
  if (!isFreeModel(aiConfig.provider, aiConfig.model)) {
    return { ok: false, reason: "not_free" };
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { ok: false, reason: "not_configured" };

  const started = Date.now();
  let last: EstimateResult = { ok: false, reason: "failed" };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const remaining = BATCH_BUDGET_MS - (Date.now() - started);
    if (remaining < 5_000) break;
    last = await attemptEstimate(
      apiKey,
      dishes,
      Math.min(remaining, Math.max(aiConfig.requestTimeoutMs, 30_000)),
    );
    if (last.ok && last.estimates.size > 0) return last;
  }
  return last;
}

async function attemptEstimate(
  apiKey: string,
  dishes: EstimateDish[],
  timeoutMs: number,
): Promise<EstimateResult> {
  const freeFallbacks = aiConfig.modelFallbacks.filter((m) =>
    isFreeModel(aiConfig.provider, m),
  );
  const { system, user } = estimatePrompt(dishes);

  try {
    const response = await fetch(OPENROUTER_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://tableside.menu",
        "X-Title": "Tableside",
      },
      body: JSON.stringify({
        // Same rule as openrouter-model-call.ts: never send `model` and
        // `models` together.
        ...(freeFallbacks.length > 0
          ? { models: [aiConfig.model, ...freeFallbacks] }
          : { model: aiConfig.model }),
        max_tokens: 3000,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, reason: "failed" };
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") return { ok: false, reason: "failed" };
    return { ok: true, estimates: parseEstimateReply(content, dishes) };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
