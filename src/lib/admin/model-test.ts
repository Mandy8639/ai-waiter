import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { aiConfig } from "@/lib/ai/config";
import { openRouterModels } from "@/lib/ai/model-list";
import type { AiJob } from "@/lib/ai/model-settings-core";
import { runConversationLoop } from "@/lib/ai/loop";
import { AiProviderError } from "@/lib/ai/provider-error";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";
import { getToolDefinitions } from "@/lib/ai/tools/index";
import {
  appendAssistantMessage,
  appendToolResultMessage,
  appendUserMessage,
  parseOpenRouterResponse,
  toOpenRouterMessages,
  toOpenRouterTools,
  type OpenRouterChatResponse,
  type OpenRouterMessage,
} from "@/lib/ai/providers/openrouter-mapping";
import { buildTextAcceptanceGuards } from "@/lib/ai/providers/text-acceptance-guards";
import {
  EXTRACTION_PROMPT,
  parseExtraction,
} from "@/lib/menu-import/extraction";
import {
  parseSuggestions,
  SUGGESTION_PROMPT,
} from "@/lib/menu-import/suggestions";
import {
  interpretMessages,
  parseInterpretation,
} from "@/lib/staff-assistant/interpret-core";
import { draftPrompt, parseDraftReply } from "@/lib/translations/core";
import {
  allPassed,
  DRAFT_TEST_FIELD,
  excerpt,
  gradeDraft,
  gradeStaff,
  gradeSuggestions,
  gradeVision,
  gradeWaiter,
  sampleToolOutcome,
  SAMPLE_RESTAURANT_NAME,
  STAFF_TEST_COMMAND,
  SUGGESTION_TEST_DISHES,
  WAITER_TEST_QUESTION,
  type ModelTestResult,
  type TestCheck,
} from "./model-test-core";

/**
 * Runs the Admin page's Test for one job on one exact model list
 * (model-test-core.ts says what each test asks and what passes). One real
 * OpenRouter request per job (the waiter's may take a few, for its tool
 * calls), with the job's real prompt and parser, and nothing written
 * anywhere. Spends real credit when the list has a paid model; the cost
 * OpenRouter reports is shown with the result.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/** The fixture the menu reader was vetted on. Bundled for /admin by next.config.ts. */
const BOARD_PATH = path.join(process.cwd(), "tests/fixtures/menu-board.jpg");

interface CallResult {
  json: OpenRouterChatResponse | null;
  status: number;
  error?: string;
}

/** Tallies time and cost across the calls one Test makes. */
class Meter {
  costUsd: number | null = 0;
  servedModel: string | undefined;

  async call(
    models: string[],
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<CallResult> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return { json: null, status: 0, error: "OPENROUTER_API_KEY isn't set." };
    }
    const list = openRouterModels(models);
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://tableside.menu",
          "X-Title": "Tableside admin test",
        },
        body: JSON.stringify({
          // Never `model` and `models` together (docs/ai.md#model-fallback).
          ...(list.length > 1 ? { models: list } : { model: list[0] }),
          ...body,
          // Asks OpenRouter to report what this request cost.
          usage: { include: true },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return {
        json: null,
        status: 0,
        error: timedOut
          ? `No answer within ${Math.round(timeoutMs / 1000)} seconds.`
          : "Couldn't reach OpenRouter.",
      };
    }
    const json = (await response.json().catch(() => null)) as
      | (OpenRouterChatResponse & {
          usage?: { cost?: unknown };
          error?: { message?: unknown };
        })
      | null;
    if (json?.model) this.servedModel = json.model;
    if (!response.ok) {
      // A refused request isn't billed, so it leaves the cost as it was.
      const message =
        typeof json?.error?.message === "string" ? json.error.message : "";
      return {
        json: null,
        status: response.status,
        error:
          response.status === 429
            ? "Every model in the list was busy (rate limited). Try again in a minute, or add a backup."
            : `OpenRouter answered ${response.status}${message ? `: ${message}` : ""}.`,
      };
    }
    const cost = Number(json?.usage?.cost);
    this.costUsd =
      this.costUsd !== null &&
      json?.usage?.cost != null &&
      Number.isFinite(cost)
        ? this.costUsd + cost
        : null;
    return { json, status: response.status };
  }
}

function content(json: CallResult["json"]): string {
  return json?.choices?.[0]?.message?.content ?? "";
}

type JobOutcome = { checks: TestCheck[]; reply: string; error?: string };

async function testWaiter(meter: Meter, models: string[]): Promise<JobOutcome> {
  const tools = toOpenRouterTools(getToolDefinitions());
  const system = buildSystemPrompt({
    restaurantName: SAMPLE_RESTAURANT_NAME,
    allowUpselling: false,
  });
  try {
    const result = await runConversationLoop<OpenRouterMessage[]>({
      initialMessages: toOpenRouterMessages(system, [], WAITER_TEST_QUESTION),
      maxToolCalls: aiConfig.maxToolCallsPerTurn,
      callModel: async (messages) => {
        const r = await meter.call(
          models,
          { max_tokens: aiConfig.maxOutputTokens, messages, tools },
          Math.max(aiConfig.requestTimeoutMs, 30_000),
        );
        if (!r.json) throw new AiProviderError(r.error ?? "failed", "unknown");
        return parseOpenRouterResponse(r.json);
      },
      callTool: async (name, args) => sampleToolOutcome(name, args),
      appendAssistantMessage,
      appendToolResultMessage,
      textAcceptanceGuards: buildTextAcceptanceGuards({
        requiresAuthoritativeMenuSource: true,
        requiresAllergenSource: false,
        appendUserMessage,
      }),
    });
    return { checks: gradeWaiter(result), reply: result.finalText };
  } catch (error) {
    return {
      checks: [],
      reply: "",
      error: error instanceof Error ? error.message : "The test failed.",
    };
  }
}

async function testStaff(meter: Meter, models: string[]): Promise<JobOutcome> {
  const r = await meter.call(
    models,
    { max_tokens: 300, messages: interpretMessages(STAFF_TEST_COMMAND) },
    30_000,
  );
  if (!r.json) return { checks: [], reply: "", error: r.error };
  const intent = parseInterpretation(content(r.json));
  return {
    checks: gradeStaff(intent),
    reply: `“${STAFF_TEST_COMMAND}” → ${JSON.stringify(intent)}`,
  };
}

async function testVision(meter: Meter, models: string[]): Promise<JobOutcome> {
  let jpg: string;
  try {
    jpg = (await readFile(BOARD_PATH)).toString("base64");
  } catch {
    return { checks: [], reply: "", error: "The test menu photo is missing." };
  }
  const r = await meter.call(
    models,
    {
      max_tokens: 16_000,
      // Thinking off, as in production (src/lib/menu-import/vision.ts).
      reasoning: { enabled: false },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: EXTRACTION_PROMPT },
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${jpg}` },
            },
          ],
        },
      ],
    },
    120_000,
  );
  if (!r.json) return { checks: [], reply: "", error: r.error };
  const parsed = parseExtraction(content(r.json));
  return {
    checks: gradeVision(parsed),
    reply: parsed.drafts
      .map((d) => `${d.name}: ${d.price === null ? "no price" : d.price}`)
      .join("\n"),
  };
}

async function testSuggestions(
  meter: Meter,
  models: string[],
): Promise<JobOutcome> {
  const r = await meter.call(
    models,
    {
      max_tokens: 6000,
      reasoning: { enabled: false },
      messages: [
        {
          role: "user",
          content: `${SUGGESTION_PROMPT}\n\nDishes:\n${SUGGESTION_TEST_DISHES.map((n) => `- ${n}`).join("\n")}`,
        },
      ],
    },
    120_000,
  );
  if (!r.json) return { checks: [], reply: "", error: r.error };
  const outcome = parseSuggestions(content(r.json));
  return {
    checks: gradeSuggestions(outcome),
    reply: outcome.suggestions
      .map(
        (s) =>
          `${s.name}: ${s.ingredients.slice(0, 4).join(", ")}${s.allergens.length ? ` · allergens: ${s.allergens.join(", ")}` : ""}`,
      )
      .join("\n"),
  };
}

async function testDrafts(meter: Meter, models: string[]): Promise<JobOutcome> {
  const fields = [DRAFT_TEST_FIELD];
  const { system, user } = draftPrompt("es", fields);
  const r = await meter.call(
    models,
    {
      max_tokens: 1000,
      reasoning: { enabled: false },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
    60_000,
  );
  if (!r.json) return { checks: [], reply: "", error: r.error };
  const translations = parseDraftReply(content(r.json), fields, "es");
  return {
    checks: gradeDraft(translations),
    reply: translations.get(DRAFT_TEST_FIELD.key) ?? content(r.json),
  };
}

const RUNNERS: Record<
  AiJob,
  (meter: Meter, models: string[]) => Promise<JobOutcome>
> = {
  waiter: testWaiter,
  staff_assistant: testStaff,
  vision: testVision,
  suggestions: testSuggestions,
  drafts: testDrafts,
};

export async function runModelTest(
  job: AiJob,
  models: string[],
): Promise<ModelTestResult> {
  const meter = new Meter();
  const started = Date.now();
  const outcome = await RUNNERS[job](meter, models);
  return {
    job,
    models,
    passed: !outcome.error && allPassed(outcome.checks),
    checks: outcome.checks,
    reply: excerpt(outcome.reply),
    servedModel: meter.servedModel,
    ms: Date.now() - started,
    costUsd: meter.costUsd,
    ...(outcome.error ? { error: outcome.error } : {}),
  };
}
