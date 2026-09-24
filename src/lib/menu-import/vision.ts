import "server-only";
import { aiConfig } from "@/lib/ai/config";
import {
  parseExtraction,
  EXTRACTION_PROMPT,
  type ParseOutcome,
} from "./extraction";

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

/** A whole board's worth of JSON. Set high because truncation looks exactly like a bad model. */
const MAX_OUTPUT_TOKENS = 8000;

/** Reading several photographs is slow; this is generous on purpose. */
const REQUEST_TIMEOUT_MS = 180_000;

/**
 * The reader's preference list, primary first.
 *
 * A list rather than one pinned model for the same reason the waiter has
 * one: these are free models, and the failure that matters is the whole
 * feature going down when one of them rate-limits. Vetted per job — see
 * aiConfig's DEFAULT_VISION_MODELS. "Supports image input" is not the
 * bar; "reads every price and invents none" is.
 */
export function visionModels(): string[] {
  return aiConfig.visionModels;
}

/** The primary, for callers that only need to name one (logging, tests). */
export function visionModel(): string {
  return visionModels()[0];
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

  const model = visionModel();

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
        models: visionModels(),
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          {
            role: "user",
            // All pages in one message: a menu split across photographs is
            // one document, and categories routinely continue across a
            // page break.
            content: [
              { type: "text", text: EXTRACTION_PROMPT },
              ...input.imageDataUrls.map((url) => ({
                type: "image_url" as const,
                image_url: { url },
              })),
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      ok: false,
      drafts: [],
      unpricedCount: 0,
      model,
      error: timedOut
        ? "Reading the menu took too long. Try fewer pages at a time."
        : "Couldn't reach the menu reader. Please try again.",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      drafts: [],
      unpricedCount: 0,
      model,
      error:
        response.status === 429
          ? "The menu reader is busy right now. Please try again in a moment."
          : "The menu reader failed. Please try again.",
    };
  }

  let json: {
    model?: string;
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  try {
    json = await response.json();
  } catch {
    return {
      ok: false,
      drafts: [],
      unpricedCount: 0,
      model,
      error: "The menu reader returned something unreadable. Please try again.",
    };
  }

  const text = json.choices?.[0]?.message?.content ?? "";
  const parsed = parseExtraction(text);
  // json.model, not the requested one: under any routing the served model
  // is what should be recorded against the import.
  return { ...parsed, model: json.model ?? model };
}
