import "server-only";
import { aiConfig } from "@/lib/ai/config";
import {
  draftPrompt,
  isFreeModel,
  parseDraftReply,
  type DraftField,
} from "./core";
import type { MenuLanguage } from "./languages";

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export type DraftResult =
  | { ok: true; translations: Map<string, string> }
  | { ok: false; reason: "not_free" | "not_configured" | "failed" };

/**
 * Asks the free model for draft translations of one batch of fields
 * (phase K). Drafts only: nothing here is shown to a diner until a person
 * approves it. Refuses outright unless the configured model is free.
 */
export async function draftTranslations(
  language: MenuLanguage,
  fields: DraftField[],
): Promise<DraftResult> {
  if (!isFreeModel(aiConfig.provider, aiConfig.model)) {
    return { ok: false, reason: "not_free" };
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { ok: false, reason: "not_configured" };

  const freeFallbacks = aiConfig.modelFallbacks.filter((m) =>
    isFreeModel(aiConfig.provider, m),
  );
  const { system, user } = draftPrompt(language, fields);

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
        max_tokens: 4000,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(aiConfig.requestTimeoutMs),
    });
    if (!response.ok) return { ok: false, reason: "failed" };
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") return { ok: false, reason: "failed" };
    return {
      ok: true,
      translations: parseDraftReply(content, fields, language),
    };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
