import { openRouterModels } from "@/lib/ai/model-list";
import "server-only";
import { aiConfig } from "@/lib/ai/config";
import { getModelsFor } from "@/lib/ai/model-settings";
import { AiProviderError } from "@/lib/ai/provider-error";
import { getSafetyNetModels } from "@/lib/ai/safety-net";
import { callWithSafetyNet } from "@/lib/ai/safety-net-core";
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

  type Reply = {
    model?: string;
    choices?: Array<{ message?: { content?: string | null } }>;
  } | null;

  const ask = async (models: string[]): Promise<Reply> => {
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://tableside.menu",
          "X-Title": "Tableside staff assistant",
        },
        body: JSON.stringify({
          // `models` alone — never alongside `model` (docs/ai.md#model-fallback).
          models: openRouterModels(models),
          max_tokens: 300,
          messages: interpretMessages(text),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new AiProviderError(
        "staff interpreter request failed",
        error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "network_error",
      );
    }
    if (!response.ok) {
      throw new AiProviderError(
        `staff interpreter: ${response.status}`,
        response.status === 429 ? "rate_limited" : "http_error",
      );
    }
    return (await response.json().catch(() => null)) as Reply;
  };

  // When the whole list is busy, one more try on the free safety net
  // (docs/admin.md). Staff still confirm every change before it happens.
  let json: Reply;
  try {
    json = await callWithSafetyNet({
      primary: (await getModelsFor("staff_assistant")).models,
      call: ask,
      safetyNet: () => getSafetyNetModels("staff_assistant"),
      onUsed: (net, error) =>
        console.info(
          JSON.stringify({
            event: "staff_safety_net_used",
            models: net,
            reason: error.category,
          }),
        ),
    });
  } catch {
    return { intent: { kind: "unknown" } };
  }

  return {
    intent: parseInterpretation(json?.choices?.[0]?.message?.content),
    model: json?.model,
  };
}
