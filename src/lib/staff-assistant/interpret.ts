import { openRouterModels } from "@/lib/ai/model-list";
import "server-only";
import { aiConfig } from "@/lib/ai/config";
import type { StaffIntent } from "./intent";
import { interpretMessages, parseInterpretation } from "./interpret-core";

/**
 * Asks the model what a command the built-in phrases didn't understand
 * means. One JSON-out call with no tools, like the menu suggester, so it
 * speaks OpenRouter's API directly rather than through the waiter's
 * conversation seam (see src/lib/menu-import/vision.ts for why). Any
 * failure — not configured, timed out, rate-limited, nonsense — reads as
 * `unknown`, and the person is shown the commands that do work.
 */

const ENDPOINT =
  process.env.OPENROUTER_ENDPOINT ??
  "https://openrouter.ai/api/v1/chat/completions";

/** Mid-service: better to say "didn't catch that" than keep someone waiting. */
const TIMEOUT_MS = 15_000;

export function isStaffInterpreterConfigured(): boolean {
  return aiConfig.provider === "openrouter" && !!process.env.OPENROUTER_API_KEY;
}

export async function interpretWithModel(text: string): Promise<{
  intent: StaffIntent;
  model?: string;
}> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || !isStaffInterpreterConfigured()) {
    return { intent: { kind: "unknown" } };
  }

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://tableside.menu",
      "X-Title": "Tableside staff assistant",
    },
    body: JSON.stringify({
      // `models` alone — never alongside `model` (docs/ai.md#model-fallback).
      models: openRouterModels(aiConfig.staffAssistantModels),
      max_tokens: 300,
      messages: interpretMessages(text),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);

  if (!response || !response.ok) return { intent: { kind: "unknown" } };

  const json = (await response.json().catch(() => null)) as {
    model?: string;
    choices?: Array<{ message?: { content?: string | null } }>;
  } | null;

  return {
    intent: parseInterpretation(json?.choices?.[0]?.message?.content),
    model: json?.model,
  };
}
