import "server-only";
import { z } from "zod";
import { getAiProvider, isAiConfigured } from "./providers";
import { aiConfig } from "./config";
import { buildSystemPrompt } from "./system-prompt";
import { executeTool } from "./tools/index";
import { getRecentMessages, insertMessage } from "./conversation";
import { isRateLimited } from "./rate-limit";
import { logAiTurn, logAiToolCall, logAiError } from "./logging";
import type { ToolContext } from "./tools/types";

export interface SendAiMessageParams {
  restaurantId: string;
  restaurantSlug: string;
  restaurantName: string;
  customerSessionId: string;
  allowUpselling: boolean;
  message: string;
}

export interface SendAiMessageResult {
  ok: boolean;
  reply?: string;
  error?: string;
  /** Set only when a submit_order tool call succeeded this turn — the UI uses this to offer/navigate to the confirmation page, never trusting the model's own claim that an order went through. */
  orderId?: string;
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
      model: aiConfig.model,
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

  await insertMessage(restaurantId, customerSessionId, "user", trimmed);

  const history = await getRecentMessages(customerSessionId);
  // Only the conversational (user/assistant) turns are replayed to the
  // model — 'tool' rows are this codebase's own audit log, not part of
  // any provider's message structure, and the model doesn't need the
  // exact mechanics of a past turn's tool calls to remember what was said.
  const historyMessages = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

  const context: ToolContext = {
    restaurantId,
    restaurantSlug,
    customerSessionId,
    turnIdempotencyKey: crypto.randomUUID(),
  };

  const system = buildSystemPrompt({
    restaurantName,
    allowUpselling: params.allowUpselling,
  });

  try {
    const loopResult = await provider.runTurn({
      system,
      history: historyMessages,
      userMessage: trimmed,
      maxToolCalls: aiConfig.maxToolCallsPerTurn,
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
        model: aiConfig.model,
        provider: aiConfig.provider,
        outcome: "refused",
      });
      const declineText =
        "I'm not able to help with that. Is there something else about the menu or your order I can help with?";
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
      finalText =
        "I'm having trouble finishing that in one go — could you break that into a smaller request?";
      logAiTurn({
        restaurantId,
        customerSessionId,
        toolCallCount: loopResult.toolCallCount,
        latencyMs: Date.now() - start,
        model: aiConfig.model,
        provider: aiConfig.provider,
        outcome: "tool_limit_exceeded",
      });
    }

    if (!finalText) {
      finalText =
        "Sorry, I didn't quite catch that — could you say it a different way?";
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

    if (!loopResult.toolLimitExceeded) {
      logAiTurn({
        restaurantId,
        customerSessionId,
        toolCallCount: loopResult.toolCallCount,
        latencyMs: Date.now() - start,
        model: aiConfig.model,
        provider: aiConfig.provider,
        outcome: "ok",
      });
    }

    return { ok: true, reply: finalText, orderId: orderId?.orderId };
  } catch (error) {
    logAiError({
      restaurantId,
      customerSessionId,
      category: "provider_error",
      message: error instanceof Error ? error.message : "unknown error",
    });
    logAiTurn({
      restaurantId,
      customerSessionId,
      toolCallCount: 0,
      latencyMs: Date.now() - start,
      model: aiConfig.model,
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
