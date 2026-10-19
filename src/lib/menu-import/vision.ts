import { openRouterModels } from "@/lib/ai/model-list";
import "server-only";
import { aiConfig } from "@/lib/ai/config";
import { getModelsFor } from "@/lib/ai/model-settings";
import { recordAiUsage } from "@/lib/ai/usage";
import { addCall, newTally, USAGE_REQUEST } from "@/lib/ai/usage-core";
import { EXTRACTION_PROMPT, type ParseOutcome } from "./extraction";
import { extractPages, type CallVisionModel } from "./vision-core";

/**
 * Sends menu photographs to a vision model and returns draft rows.
 *
 * Deliberately NOT routed through src/lib/ai/providers/. That seam models a
 * *conversation*: a system prompt, message history, tool definitions, a
 * tool-call loop, refusal handling. Menu extraction is none of those — it
 * is one image-in, JSON-out call with no tools and no turns. Forcing it
 * through AiConversationTurn would mean adding image content, an
 * optional-tools mode and a no-history mode to an interface whose whole
 * value is that loop.ts and tools/ never have to know two providers exist.
 *
 * What IS shared is the credential and the endpoint, so a restaurant that
 * has configured OpenRouter for the AI waiter needs nothing extra.
 *
 * The model is pinned separately from the chat model for the same reason
 * the chat list is curated (docs/ai.md#model-fallback): this is a different
 * job with a different requirement — reading small print off a photograph
 * without inventing anything — and the model that does it well is not
 * necessarily the one that holds a conversation well.
 */

const OPENROUTER_ENDPOINT =
  process.env.OPENROUTER_ENDPOINT ??
  "https://openrouter.ai/api/v1/chat/completions";

/**
 * One photo's worth of JSON plus the model's thinking. Set high because
 * truncation looks exactly like a bad model: at 8,000 a dense two-page
 * menu read in one request ran out (vision-core.ts).
 */
const MAX_OUTPUT_TOKENS = 16_000;

/**
 * Per try. Photos are read at the same time and each gets two tries, so
 * the worst case (2 × 120 s) stays inside the import page's 300 s limit.
 */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * The reader's preference list, primary first.
 *
 * A list rather than one pinned model for the same reason the waiter has
 * one: these are free models, and the failure that matters is the whole
 * feature going down when one of them rate-limits. Vetted per job — see
 * aiConfig's DEFAULT_VISION_MODELS. "Supports image input" is not the
 * bar; "reads every price and invents none" is.
 */
export async function visionModels(): Promise<string[]> {
  return (await getModelsFor("vision")).models;
}

/** The primary, for callers that only need to name one (logging, tests). */
export async function visionModel(): Promise<string> {
  return (await visionModels())[0];
}

export function isMenuImportConfigured(): boolean {
  // Extraction currently speaks OpenRouter's API shape only. Stated as a
  // capability check rather than assumed, so the UI can offer manual entry
  // instead of a button that fails.
  return aiConfig.provider === "openrouter" && !!process.env.OPENROUTER_API_KEY;
}

export interface ExtractionInput {
  /** Data URLs (`data:image/png;base64,...`), one per uploaded page. */
  imageDataUrls: string[];
  /** Whose import this is, so its AI cost is counted against it (ai_usage). */
  restaurantId?: string;
}

export interface ExtractionOutcome extends ParseOutcome {
  /** What actually served the request, recorded on the import row for traceability. */
  model?: string;
}

export async function extractMenuFromImages(
  input: ExtractionInput,
): Promise<ExtractionOutcome> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      drafts: [],
      unpricedCount: 0,
      error: "Menu reading isn't configured. Add the items manually for now.",
    };
  }
  if (input.imageDataUrls.length === 0) {
    return {
      ok: false,
      drafts: [],
      unpricedCount: 0,
      error: "No pages were uploaded.",
    };
  }

  const tally = newTally();
  const call: CallVisionModel = async (imageDataUrl, modelList) => {
    let response: Response;
    try {
      response = await fetch(OPENROUTER_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://tableside.menu",
          "X-Title": "Tableside menu import",
        },
        body: JSON.stringify({
          // `models`, never `models` AND `model` together: the singular
          // field wins and the fallback list is silently ignored, with no
          // error — see docs/ai.md#model-fallback.
          models: modelList,
          max_tokens: MAX_OUTPUT_TOKENS,
          // Thinking off. These models think before answering, and on a
          // dense board they never stop: on a real 134-dish photo (2026-10-18)
          // nemotron-3.5-super-vl spent all 16,000 tokens thinking and dots-3
          // ran out after ~10,000, both with no answer. "effort: low" and a
          // thinking cap didn't help. With thinking off, dots-3 read all 134
          // in 27 s and every price matched the board, and the trap line
          // still came back unpriced. Reading print doesn't need deliberation.
          reasoning: { enabled: false },
          ...USAGE_REQUEST,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: EXTRACTION_PROMPT },
                {
                  type: "image_url" as const,
                  image_url: { url: imageDataUrl },
                },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        status: 0,
        content: "",
        timedOut: error instanceof Error && error.name === "TimeoutError",
      };
    }
    const json = (await response.json().catch(() => null)) as {
      model?: string;
      error?: { message?: string };
      choices?: Array<{
        finish_reason?: string | null;
        message?: { content?: string | null };
      }>;
    } | null;
    if (response.ok) addCall(tally, json, json?.model);
    return {
      status: response.status,
      content: json?.choices?.[0]?.message?.content ?? "",
      finishReason: json?.choices?.[0]?.finish_reason,
      servedModel: json?.model,
      bodyError: json?.error?.message,
    };
  };

  const models = await visionModels();
  const outcome = await extractPages(
    input.imageDataUrls,
    openRouterModels(models),
    call,
  );
  await recordAiUsage({
    tally,
    job: "vision",
    restaurantId: input.restaurantId,
  });
  return { ...outcome, model: outcome.model ?? models[0] };
}
