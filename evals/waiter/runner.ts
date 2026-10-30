import type { z } from "zod";
import { runConversationLoop } from "@/lib/ai/loop";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";
import { buildHistoryMessages, buildRecentToolContext } from "@/lib/ai/history";
import { complimentReply, isOnlyCompliment } from "@/lib/ai/compliment-core";
import {
  addedToCartText,
  fallbackLanguage,
  fallbackText,
  foundDishesText,
} from "@/lib/ai/fallback-text";
import { dishesForEmptyReply } from "@/lib/ai/empty-reply-core";
import {
  acceptsAllergyHold,
  addedToCart,
  allergyHoldText,
  holdsIn,
} from "@/lib/ai/tools/allergy-hold";
import { formatMoney } from "@/lib/orders/format";
import {
  looksLikeAllergenQuestion,
  looksLikeMenuFactQuestion,
} from "@/lib/ai/tools/menu-fact-detection";
import {
  buildTextAcceptanceGuards,
  CART_STATE_GUARD_ID,
} from "@/lib/ai/providers/text-acceptance-guards";
import {
  appendAssistantMessage,
  appendToolResultMessage,
  appendUserMessage,
  toOpenRouterMessages,
  toOpenRouterTools,
  type OpenRouterMessage,
} from "@/lib/ai/providers/openrouter-mapping";
import { callOpenRouterModel } from "@/lib/ai/providers/openrouter-model-call";
import { AiProviderError } from "@/lib/ai/provider-error";
import { aiConfig } from "@/lib/ai/config";
import { allTools, getToolDefinitions } from "@/lib/ai/tools/index";
import {
  noFalseSuccessClaims,
  noInventedPrices,
  runChecks,
  type CheckOutcome,
  type TurnRecord,
  type VisitRecord,
} from "./checks";
import { MENU_PRICES, RESTAURANT } from "./menu";
import type { Scenario } from "./scenarios";
import { World } from "./world";

/**
 * Plays a scenario through the waiter the way production does
 * (src/lib/ai/orchestrator.ts + providers/openrouter.ts): the same system
 * prompt, history, tool definitions, tool-call loop, text-acceptance
 * guards, compliment shortcut and fallbacks, against a real model on
 * OpenRouter. Only the tools' storage is swapped for the in-memory World.
 *
 * Kept in step with orchestrator.ts by hand: if the turn logic there
 * changes (a new guard, a new shortcut), change it here too, or the
 * evaluation measures a waiter that no longer exists.
 */

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export interface ScenarioResult {
  id: string;
  category: string;
  model: string;
  passed: boolean;
  /** The run couldn't be judged: the model call itself failed. Not counted as a pass or a fail. */
  infraError?: string;
  checks: CheckOutcome[];
  turns: TurnRecord[];
  ms: number;
}

const toolSchemas = new Map<string, z.ZodType>(
  allTools.map((t) => [t.name, t.schema as z.ZodType]),
);
const tools = toOpenRouterTools(getToolDefinitions());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callModelWithRetry(
  model: string,
  apiKey: string,
  messages: OpenRouterMessage[],
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callOpenRouterModel({
        endpoint: OPENROUTER_ENDPOINT,
        apiKey,
        model,
        maxOutputTokens: aiConfig.maxOutputTokens,
        // Free models are slow; a timeout here is a flaky run, not a judgement.
        requestTimeoutMs: Math.max(aiConfig.requestTimeoutMs, 60_000),
        messages,
        tools,
      });
    } catch (error) {
      const retryable =
        error instanceof AiProviderError &&
        (error.category === "rate_limited" ||
          error.category === "timeout" ||
          error.category === "network_error");
      if (!retryable || attempt >= 3) throw error;
      await sleep(5_000 * 2 ** attempt);
    }
  }
}

async function runTurn(
  world: World,
  userMessage: string,
  model: string,
  apiKey: string,
): Promise<TurnRecord> {
  // History is read before the new message is stored, as in production.
  const history = [...world.messages];
  world.addMessage("user", userMessage);
  const callsBefore = world.calls.length;
  const language = fallbackLanguage(userMessage);

  if (isOnlyCompliment(userMessage)) {
    const reply = complimentReply(language);
    world.addMessage("assistant", reply);
    return { user: userMessage, reply, calls: [], path: "fixed" };
  }

  const system = buildSystemPrompt({
    restaurantName: RESTAURANT.name,
    allowUpselling: true,
    recentToolContext: buildRecentToolContext(history),
  });

  try {
    const loop = await runConversationLoop<OpenRouterMessage[]>({
      initialMessages: toOpenRouterMessages(
        system,
        buildHistoryMessages(history),
        userMessage,
      ),
      maxToolCalls: aiConfig.maxToolCallsPerTurn,
      callModel: (messages) => callModelWithRetry(model, apiKey, messages),
      callTool: (name, args) => world.executeTool(name, args),
      appendAssistantMessage,
      appendToolResultMessage,
      textAcceptanceGuards: buildTextAcceptanceGuards({
        requiresAuthoritativeMenuSource: looksLikeMenuFactQuestion(userMessage),
        requiresAllergenSource: looksLikeAllergenQuestion(userMessage),
        appendUserMessage,
      }),
    });

    let reply = loop.finalText;
    let path: TurnRecord["path"] = "model";
    if (loop.refused) {
      reply = fallbackText("decline", language);
      path = "fixed";
    } else if (loop.toolLimitExceeded) {
      reply = fallbackText("toolLimit", language);
      path = "fixed";
    } else if (loop.guardCorrectionExhausted) {
      reply = addedToCart(loop.toolOutcomes)
        ? addedToCartText(language)
        : fallbackText(
            loop.exhaustedGuardId === CART_STATE_GUARD_ID
              ? "cartState"
              : "menuFact",
            language,
          );
      path = "fixed";
    }
    if (!reply) {
      // As orchestrator.ts: dishes this turn's lookups found, else the
      // fixed "didn't catch that".
      const found = dishesForEmptyReply(loop.toolOutcomes);
      reply =
        found.dishes.length > 0
          ? foundDishesText(
              found.dishes.map(
                (d) => `${d.name} (${formatMoney(d.price, d.currency)})`,
              ),
              found.kind,
              language,
            )
          : fallbackText("didNotCatch", language);
      path = "fixed";
    }
    // As orchestrator.ts: a guest whose dish was held always gets told.
    if (!acceptsAllergyHold(loop.toolOutcomes, reply)) {
      reply = allergyHoldText(holdsIn(loop.toolOutcomes), language);
      path = "fixed";
    }
    world.addMessage("assistant", reply);
    return {
      user: userMessage,
      reply,
      calls: world.calls.slice(callsBefore),
      path,
    };
  } catch (error) {
    // Production shows a fallback here too; the evaluation records it as
    // an infrastructure failure instead of judging an answer that was
    // never given.
    const message = error instanceof Error ? error.message : String(error);
    world.addMessage("assistant", fallbackText("didNotCatch", language));
    return {
      user: userMessage,
      reply: "",
      calls: world.calls.slice(callsBefore),
      path: "fixed",
      error: message,
    };
  }
}

export async function runScenario(
  scenario: Scenario,
  model: string,
  apiKey: string,
): Promise<ScenarioResult> {
  const started = Date.now();
  const world = new World(toolSchemas);
  scenario.setup?.(world);

  const turns: TurnRecord[] = [];
  for (const message of scenario.turns) {
    const turn = await runTurn(world, message, model, apiKey);
    turns.push(turn);
    if (turn.error) break;
  }

  const visit: VisitRecord = {
    turns,
    cart: world.cart.map((l) => ({ ...l })),
    orders: world.orders.map((o) => ({
      status: o.status,
      lines: o.lines.map((l) => ({ ...l })),
    })),
    serviceRequests: [...world.serviceRequests],
  };

  const infraError = turns.find((t) => t.error)?.error;
  const checks = infraError
    ? []
    : runChecks(
        [
          ...scenario.checks,
          noInventedPrices(MENU_PRICES),
          noFalseSuccessClaims(),
        ],
        visit,
      );

  return {
    id: scenario.id,
    category: scenario.category,
    model,
    passed: !infraError && checks.every((c) => c.passed),
    infraError,
    checks,
    turns,
    ms: Date.now() - started,
  };
}
