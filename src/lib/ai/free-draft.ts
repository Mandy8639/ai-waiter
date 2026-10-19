import "server-only";
import { aiConfig } from "@/lib/ai/config";
import { isFreeModel } from "@/lib/translations/core";
import { retryDraft, type DraftAttempt } from "./free-draft-core";

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export type FreeDraftResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "not_free" | "not_configured" | "failed" };

/**
 * One owner-side AI draft on the configured free model, with retries
 * (src/lib/ai/free-draft-core.ts). Used by translation drafting and
 * nutrition estimates; whatever it returns is a draft a person reviews.
 * Refuses outright unless the configured model is free: this app doesn't
 * spend money on AI without the owner deciding to.
 */
export async function freeModelDraft<T>(input: {
  system: string;
  user: string;
  maxTokens: number;
  /** Turns the model's text into a value; never throws. */
  parse: (reply: string) => T;
  /** Whether a parsed value has anything worth saving. */
  usable: (value: T) => boolean;
}): Promise<FreeDraftResult<T>> {
  if (!isFreeModel(aiConfig.provider, aiConfig.model)) {
    return { ok: false, reason: "not_free" };
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { ok: false, reason: "not_configured" };

  const freeFallbacks = aiConfig.modelFallbacks.filter((m) =>
    isFreeModel(aiConfig.provider, m),
  );

  const attempt = async (timeoutMs: number): Promise<DraftAttempt<T>> => {
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
          max_tokens: input.maxTokens,
          // Thinking off: the free models think before answering, and the
          // thinking spends the same allowance. Found 2026-10-18 on a real
          // 249-dish menu: a 15-dish nutrition batch used 2,076 of 3,000
          // tokens thinking and returned nothing ("The free AI model didn't
          // answer"); with thinking off, all 15 in 7 s. Drafts are reviewed
          // by a person anyway. Ignored by models that don't think.
          reasoning: { enabled: false },
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
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
      return { ok: true, value: input.parse(content) };
    } catch {
      return { ok: false, reason: "failed" };
    }
  };

  return retryDraft(attempt, {
    usable: input.usable,
    perAttemptMs: Math.max(aiConfig.requestTimeoutMs, 30_000),
  });
}
