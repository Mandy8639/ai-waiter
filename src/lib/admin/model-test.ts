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
  looksLikeAllergenQuestion,
  looksLikeMenuFactQuestion,
} from "@/lib/ai/tools/menu-fact-detection";
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
import { recordAiUsage } from "@/lib/ai/usage";
import { addCall, newTally } from "@/lib/ai/usage-core";
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
import type { CompareAnswer } from "./compare-core";
import {
  allPassed,
  DRAFT_TEST_FIELD,
  excerpt,
  gradeDraft,
  gradeStaff,
  gradeSuggestions,
  gradeVision,
  gradeRecommendation,
  gradeWaiter,
  sampleToolOutcome,
  SAMPLE_TEST_MENU,
  type TestMenu,
  STAFF_TEST_COMMAND,
  SUGGESTION_TEST_DISHES,
  WAITER_RECOMMEND_QUESTION,
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
  /** OpenRouter answered "busy" (rate limited or overloaded) at least once. */
  busy = false;
  /** Every answered call, for ai_usage. */
  tally = newTally();

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
      if ([429, 502, 503].includes(response.status)) this.busy = true;
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
    addCall(this.tally, json, json?.model);
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

/** One waiter turn on the sample menu, guarded exactly as a real diner's turn would be. */
async function waiterTurn(
  meter: Meter,
  models: string[],
  question: string,
  menu: TestMenu = SAMPLE_TEST_MENU,
) {
  const tools = toOpenRouterTools(getToolDefinitions());
  const system = buildSystemPrompt({
    restaurantName: menu.restaurantName,
    allowUpselling: false,
  });
  return runConversationLoop<OpenRouterMessage[]>({
    initialMessages: toOpenRouterMessages(system, [], question),
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
    callTool: async (name, args) => sampleToolOutcome(name, args, menu),
    appendAssistantMessage,
    appendToolResultMessage,
    textAcceptanceGuards: buildTextAcceptanceGuards({
      requiresAuthoritativeMenuSource: looksLikeMenuFactQuestion(question),
      requiresAllergenSource: looksLikeAllergenQuestion(question),
      appendUserMessage,
    }),
  });
}

/**
 * Two questions, each a fresh conversation: a menu question that must be
 * looked up, then "What do you recommend?", which must be answered with a
 * question. The second is skipped when the first already failed.
 */
async function testWaiter(
  meter: Meter,
  models: string[],
  menu: TestMenu = SAMPLE_TEST_MENU,
): Promise<JobOutcome> {
  try {
    const first = await waiterTurn(meter, models, WAITER_TEST_QUESTION, menu);
    const checks = gradeWaiter(first, menu.dishes);
    let reply = `${WAITER_TEST_QUESTION}\n${first.finalText}`;
    if (allPassed(checks)) {
      const second = await waiterTurn(
        meter,
        models,
        WAITER_RECOMMEND_QUESTION,
        menu,
      );
      checks.push(...gradeRecommendation(second));
      reply += `\n\n${WAITER_RECOMMEND_QUESTION}\n${second.finalText}`;
    }
    return { checks, reply };
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
  waiter: (meter, models) => testWaiter(meter, models),
  staff_assistant: testStaff,
  vision: testVision,
  suggestions: testSuggestions,
  drafts: testDrafts,
};

export async function runModelTest(
  job: AiJob,
  models: string[],
  /** Counted as platform use in ai_usage, never against a restaurant. */
  source: "admin_test" | "safety_check" = "admin_test",
): Promise<ModelTestResult> {
  const meter = new Meter();
  const started = Date.now();
  const outcome = await RUNNERS[job](meter, models);
  await recordAiUsage({ tally: meter.tally, job, source });
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
    ...(outcome.error && meter.busy ? { busy: true } : {}),
  };
}

/**
 * The side-by-side test (compare-core.ts): one diner question to one
 * model alone, with no backups, on the sample menu. Counted as platform
 * use in ai_usage, like a Test.
 */
export async function compareWaiterAnswer(
  model: string,
  question: string,
): Promise<CompareAnswer> {
  const meter = new Meter();
  const started = Date.now();
  let answer: Omit<CompareAnswer, "ms" | "costUsd" | "servedModel">;
  try {
    const turn = await waiterTurn(meter, [model], question);
    answer = {
      model,
      reply: excerpt(turn.finalText),
      tools: [...new Set(turn.toolOutcomes.map((o) => o.toolName))],
      declined: turn.refused || turn.guardCorrectionExhausted,
    };
  } catch (error) {
    answer = {
      model,
      reply: "",
      tools: [],
      declined: false,
      error: error instanceof Error ? error.message : "It didn't answer.",
      ...(meter.busy ? { busy: true } : {}),
    };
  }
  await recordAiUsage({
    tally: meter.tally,
    job: "waiter",
    source: "admin_test",
  });
  return {
    ...answer,
    servedModel: meter.servedModel,
    ms: Date.now() - started,
    costUsd: meter.costUsd,
  };
}

/**
 * Phase 7: the waiter Test on one restaurant's real menu, read-only (the
 * tools answer from the dishes loaded here; nothing can be ordered).
 * Counted against that restaurant in ai_usage, as "admin_test".
 */
export async function runWaiterTestOnMenu(
  models: string[],
  menu: TestMenu,
  restaurantId: string,
): Promise<ModelTestResult> {
  const meter = new Meter();
  const started = Date.now();
  const outcome = await testWaiter(meter, models, menu);
  await recordAiUsage({
    tally: meter.tally,
    job: "waiter",
    source: "admin_test",
    restaurantId,
  });
  return {
    job: "waiter",
    models,
    passed: !outcome.error && allPassed(outcome.checks),
    checks: outcome.checks,
    reply: excerpt(outcome.reply),
    servedModel: meter.servedModel,
    ms: Date.now() - started,
    costUsd: meter.costUsd,
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.error && meter.busy ? { busy: true } : {}),
  };
}
