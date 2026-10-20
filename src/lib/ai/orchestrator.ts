import "server-only";
import { z } from "zod";
import { getAiProvider, isAiConfigured } from "./providers";
import { aiConfig } from "./config";
import { complimentReply, isOnlyCompliment } from "./compliment-core";
import { getWaiterModels } from "./waiter-models";
import { buildSystemPrompt } from "./system-prompt";
import type { AiPersona } from "./persona";
import { executeTool } from "./tools/index";
import { getRecentMessages, insertMessage } from "./conversation";
import { buildHistoryMessages, buildRecentToolContext } from "./history";
import { isRateLimited } from "./rate-limit";
import { logAiTurn, logAiToolCall, logAiError } from "./logging";
import { categorizeAiError } from "./provider-error";
import {
  looksLikeAllergenQuestion,
  looksLikeMenuFactQuestion,
} from "./tools/menu-fact-detection";
import { fallbackLanguage, fallbackText } from "./fallback-text";
import {
  ALLERGEN_SOURCE_GUARD_ID,
  CART_STATE_GUARD_ID,
  MENU_CLAIM_GUARD_ID,
} from "./providers/text-acceptance-guards";
import type { ToolContext } from "./tools/types";
import {
  selectMentionedItems,
  type MentionedMenuItem,
} from "./recommendations";

export interface SendAiMessageParams {
  restaurantId: string;
  restaurantSlug: string;
  restaurantName: string;
  customerSessionId: string;
  allowUpselling: boolean;
  /**
   * How the waiter sounds at this restaurant (phase D). Goes into the
   * system prompt and nowhere else — in particular, NOT into the
   * menu-fact guard below, which is decided from the customer's message
   * alone. That separation is what stops an owner's note from switching
   * the guard off. Omitted means the default voice.
   */
  persona?: AiPersona;
  message: string;
}

export interface SendAiMessageResult {
  ok: boolean;
  reply?: string;
  error?: string;
  /** Set only when a submit_order tool call succeeded this turn — the UI uses this to offer/navigate to the confirmation page, never trusting the model's own claim that an order went through. */
  orderId?: string;
  /**
   * Real menu rows this turn's menu tools returned AND the reply names —
   * see src/lib/ai/recommendations.ts. Empty whenever the reply is one of
   * the safe fallbacks, so a card never sits under a message that did not
   * come from the model.
   */
  mentionedItems?: MentionedMenuItem[];
}

const userMessageSchema = z.string().trim().min(1);

/**
 * The one place that talks to a model — provider-agnostic since Batch 9.
 * Builds a provider-neutral turn (system prompt, plain-text history, the
 * new message, the tool-call budget, and a callTool closure) and hands it
 * to whichever provider `getAiProvider()` (src/lib/ai/providers/) selects;
 * every provider internally calls the same, unmodified
 * `runConversationLoop()` (src/lib/ai/loop.ts), which owns the actual
 * bookkeeping (tool-call counting, the per-turn limit, refusal handling,
 * final-text extraction) as a pure, independently-unit-tested function.
 * Never throws outward — every failure mode (unconfigured, rate limited,
 * oversized input, provider error, tool-limit exceeded, refused) resolves
 * to a normal `{ ok: false, error }` or safe decline result the caller can
 * show the customer.
 */
export async function sendAiMessage(
  params: SendAiMessageParams,
): Promise<SendAiMessageResult> {
  const start = Date.now();
  // The primary the logs attribute a turn to when no model served it.
  const configuredModel =
    (await getWaiterModels(params.restaurantId)).models[0] ?? aiConfig.model;
  const { restaurantId, restaurantSlug, restaurantName, customerSessionId } =
    params;

  if (!isAiConfigured()) {
    return {
      ok: false,
      error:
        "The AI waiter isn't available right now — you can still browse the menu and order normally.",
    };
  }

  const trimmed = params.message.trim();
  const parsedMessage = userMessageSchema.safeParse(trimmed);
  if (!parsedMessage.success) {
    return { ok: false, error: "Please enter a message." };
  }
  if (trimmed.length > aiConfig.maxInputLength) {
    return {
      ok: false,
      error: `That message is too long (max ${aiConfig.maxInputLength} characters).`,
    };
  }

  if (await isRateLimited(customerSessionId)) {
    logAiTurn({
      restaurantId,
      customerSessionId,
      toolCallCount: 0,
      latencyMs: Date.now() - start,
      model: configuredModel,
      provider: aiConfig.provider,
      outcome: "rate_limited",
    });
    return {
      ok: false,
      error:
        "You've sent a lot of messages in a short time — please wait a moment and try again.",
    };
  }

  const provider = getAiProvider();
  if (!provider) {
    return { ok: false, error: "The AI waiter isn't available right now." };
  }

  // Fetched BEFORE inserting the current message — getRecentMessages()
  // would otherwise return the message we're about to insert, and it'd
  // end up in the provider request twice: once via historyMessages, once
  // via the explicit `userMessage` field below.
  const history = await getRecentMessages(customerSessionId);
  const historyMessages = buildHistoryMessages(history);
  const recentToolContext = buildRecentToolContext(history);

  await insertMessage(restaurantId, customerSessionId, "user", trimmed);

  const context: ToolContext = {
    restaurantId,
    restaurantSlug,
    customerSessionId,
    turnIdempotencyKey: crypto.randomUUID(),
  };

  // Which language the fixed replies below are in, if one is needed. From
  // the diner's own message — see fallback-text.ts.
  const replyLanguage = fallbackLanguage(trimmed);

  // A message that is only a thank-you or a compliment gets a fixed, warm
  // reply: the free model kept pitching the menu back (compliment-core.ts).
  if (isOnlyCompliment(trimmed)) {
    const reply = complimentReply(replyLanguage);
    await insertMessage(restaurantId, customerSessionId, "assistant", reply);
    logAiTurn({
      restaurantId,
      customerSessionId,
      toolCallCount: 0,
      latencyMs: Date.now() - start,
      model: "fixed-reply",
      provider: aiConfig.provider,
      outcome: "ok",
    });
    return { ok: true, reply, mentionedItems: [] };
  }

  const system = buildSystemPrompt({
    restaurantName,
    allowUpselling: params.allowUpselling,
    recentToolContext,
    persona: params.persona,
  });

  try {
    const loopResult = await provider.runTurn({
      system,
      history: historyMessages,
      userMessage: trimmed,
      maxToolCalls: aiConfig.maxToolCallsPerTurn,
      restaurantId,
      requiresAuthoritativeMenuSource: looksLikeMenuFactQuestion(trimmed),
      requiresAllergenSource: looksLikeAllergenQuestion(trimmed),
      callTool: async (name, args) => {
        const toolStart = Date.now();
        const outcome = await executeTool(name, args, context);
        logAiToolCall({
          restaurantId,
          customerSessionId,
          toolName: outcome.toolName,
          success: outcome.result.ok,
          latencyMs: Date.now() - toolStart,
        });
        await insertMessage(
          restaurantId,
          customerSessionId,
          "tool",
          JSON.stringify(outcome.result).slice(0, 4000),
          { name: outcome.toolName, success: outcome.result.ok },
        );
        return outcome;
      },
    });

    if (loopResult.refused) {
      logAiTurn({
        restaurantId,
        customerSessionId,
        toolCallCount: loopResult.toolCallCount,
        latencyMs: Date.now() - start,
        model: loopResult.servedModel ?? configuredModel,
        provider: aiConfig.provider,
        outcome: "refused",
      });
      const declineText = fallbackText("decline", replyLanguage);
      await insertMessage(
        restaurantId,
        customerSessionId,
        "assistant",
        declineText,
      );
      return { ok: true, reply: declineText };
    }

    let finalText = loopResult.finalText;

    if (loopResult.toolLimitExceeded) {
      finalText = fallbackText("toolLimit", replyLanguage);
      logAiTurn({
        restaurantId,
        customerSessionId,
        toolCallCount: loopResult.toolCallCount,
        latencyMs: Date.now() - start,
        model: loopResult.servedModel ?? configuredModel,
        provider: aiConfig.provider,
        outcome: "tool_limit_exceeded",
      });
    }

    if (loopResult.guardCorrectionExhausted) {
      // A text-acceptance guard's one corrective retry didn't get the
      // model to consult an authoritative tool — fail safely rather than
      // risking a fabricated/stale answer reaching the customer (see
      // tools/menu-fact-detection.ts and tools/cart-fact-detection.ts).
      // Each guard has its own fallback wording because the two failures
      // are not interchangeable: one means "I couldn't look up the menu",
      // the other "I couldn't confirm your cart".
      const isCartStateGuard =
        loopResult.exhaustedGuardId === CART_STATE_GUARD_ID;
      finalText = fallbackText(
        isCartStateGuard ? "cartState" : "menuFact",
        replyLanguage,
      );
      logAiTurn({
        restaurantId,
        customerSessionId,
        toolCallCount: loopResult.toolCallCount,
        latencyMs: Date.now() - start,
        model: loopResult.servedModel ?? configuredModel,
        provider: aiConfig.provider,
        // Logged per guard even where the diner sees the same words: the
        // menu-claim guard (phase D) fires on a price or halal claim the
        // model VOLUNTEERED, which is a different failure to investigate
        // from one where the customer asked and the model wouldn't look.
        outcome: isCartStateGuard
          ? "cart_state_guard_exhausted"
          : loopResult.exhaustedGuardId === MENU_CLAIM_GUARD_ID
            ? "menu_claim_guard_exhausted"
            : loopResult.exhaustedGuardId === ALLERGEN_SOURCE_GUARD_ID
              ? "allergen_source_guard_exhausted"
              : "menu_fact_guard_exhausted",
      });
    }

    if (!finalText) {
      finalText = fallbackText("didNotCatch", replyLanguage);
    }

    const orderId = loopResult.toolOutcomes.find(
      (o) => o.toolName === "submit_order" && o.result.ok,
    )?.result.data as { orderId?: string } | undefined;

    await insertMessage(
      restaurantId,
      customerSessionId,
      "assistant",
      finalText,
    );

    if (!loopResult.toolLimitExceeded && !loopResult.guardCorrectionExhausted) {
      logAiTurn({
        restaurantId,
        customerSessionId,
        toolCallCount: loopResult.toolCallCount,
        latencyMs: Date.now() - start,
        model: loopResult.servedModel ?? configuredModel,
        provider: aiConfig.provider,
        outcome: "ok",
      });
    }

    const repliedNormally =
      !loopResult.toolLimitExceeded &&
      !loopResult.guardCorrectionExhausted &&
      loopResult.finalText.length > 0;

    return {
      ok: true,
      reply: finalText,
      orderId: orderId?.orderId,
      mentionedItems: repliedNormally
        ? selectMentionedItems(finalText, loopResult.toolOutcomes)
        : [],
    };
  } catch (error) {
    logAiError({
      restaurantId,
      customerSessionId,
      category: categorizeAiError(error),
      message: error instanceof Error ? error.message : "unknown error",
    });
    logAiTurn({
      restaurantId,
      customerSessionId,
      toolCallCount: 0,
      latencyMs: Date.now() - start,
      // The call threw, so no model served this turn — the configured
      // primary is the only meaningful thing to attribute it to.
      model: configuredModel,
      provider: aiConfig.provider,
      outcome: "provider_error",
    });
    return {
      ok: false,
      error:
        "The AI waiter is having trouble responding right now. Please try again in a moment.",
    };
  }
}
