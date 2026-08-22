import { describe, expect, it } from "vitest";
import { runConversationLoop, type LoopToolOutcome } from "@/lib/ai/loop";
import * as anthropicMapping from "@/lib/ai/providers/anthropic-mapping";
import * as openrouterMapping from "@/lib/ai/providers/openrouter-mapping";

/**
 * Proves the same waiter tools produce the same outcome regardless of
 * provider (spec requirement 18). Both runs use the exact same
 * runConversationLoop() (src/lib/ai/loop.ts, unmodified by the provider
 * abstraction) and the exact same fake callTool — only the raw
 * "what the provider's API returned" shape differs, run through each
 * provider's own parse function. If both providers' mapping is honoring
 * the same contract, the resulting tool calls, tool outcomes, and final
 * text must be identical.
 */
describe("provider parity: the same tool-calling scenario via Anthropic vs. OpenRouter mapping", () => {
  const fakeCallTool = async (
    name: string,
    args: unknown,
  ): Promise<LoopToolOutcome> => {
    expect(name).toBe("get_cart");
    expect(args).toEqual({});
    return { toolName: "get_cart", result: { ok: true, data: { lines: [] } } };
  };

  it("Anthropic-shaped and OpenRouter-shaped raw responses drive an identical tool call, then an identical final reply", async () => {
    const anthropicResult = await runConversationLoop({
      initialMessages: anthropicMapping.toAnthropicMessages(
        [],
        "what's in my cart?",
      ),
      maxToolCalls: 6,
      callModel: async (messages) => {
        if (messages.length === 1) {
          return anthropicMapping.parseAnthropicResponse({
            content: [
              { type: "tool_use", id: "call-1", name: "get_cart", input: {} },
            ] as never,
            stop_reason: "tool_use",
          });
        }
        return anthropicMapping.parseAnthropicResponse({
          content: [{ type: "text", text: "Your cart is empty." }] as never,
          stop_reason: "end_turn",
        });
      },
      callTool: fakeCallTool,
      appendAssistantMessage: anthropicMapping.appendAssistantMessage,
      appendToolResultMessage: anthropicMapping.appendToolResultMessage,
    });

    const openrouterResult = await runConversationLoop({
      initialMessages: openrouterMapping.toOpenRouterMessages(
        "system prompt",
        [],
        "what's in my cart?",
      ),
      maxToolCalls: 6,
      callModel: async (messages) => {
        if (messages.length === 2) {
          return openrouterMapping.parseOpenRouterResponse({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: { name: "get_cart", arguments: "{}" },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          });
        }
        return openrouterMapping.parseOpenRouterResponse({
          choices: [
            {
              message: { role: "assistant", content: "Your cart is empty." },
              finish_reason: "stop",
            },
          ],
        });
      },
      callTool: fakeCallTool,
      appendAssistantMessage: openrouterMapping.appendAssistantMessage,
      appendToolResultMessage: openrouterMapping.appendToolResultMessage,
    });

    // Both providers must agree on the outcome that actually matters to
    // the customer and to tool authorization — which tools ran, with what
    // result, how many times, and what the customer sees — even though
    // their raw wire formats are completely different.
    expect(anthropicResult.toolCallCount).toBe(openrouterResult.toolCallCount);
    expect(anthropicResult.toolOutcomes).toEqual(openrouterResult.toolOutcomes);
    expect(anthropicResult.finalText).toBe(openrouterResult.finalText);
    expect(anthropicResult.refused).toBe(openrouterResult.refused);
    expect(anthropicResult.toolLimitExceeded).toBe(
      openrouterResult.toolLimitExceeded,
    );
  });

  it("both providers' refusal signal collapses to the same loop.ts outcome", async () => {
    const anthropicResult = await runConversationLoop({
      initialMessages: anthropicMapping.toAnthropicMessages([], "hi"),
      maxToolCalls: 6,
      callModel: async () =>
        anthropicMapping.parseAnthropicResponse({
          content: [] as never,
          stop_reason: "refusal",
        }),
      callTool: async () => {
        throw new Error("should never be called");
      },
      appendAssistantMessage: anthropicMapping.appendAssistantMessage,
      appendToolResultMessage: anthropicMapping.appendToolResultMessage,
    });

    const openrouterResult = await runConversationLoop({
      initialMessages: openrouterMapping.toOpenRouterMessages(
        "system",
        [],
        "hi",
      ),
      maxToolCalls: 6,
      callModel: async () =>
        openrouterMapping.parseOpenRouterResponse({
          choices: [
            {
              message: { role: "assistant", content: null },
              finish_reason: "content_filter",
            },
          ],
        }),
      callTool: async () => {
        throw new Error("should never be called");
      },
      appendAssistantMessage: openrouterMapping.appendAssistantMessage,
      appendToolResultMessage: openrouterMapping.appendToolResultMessage,
    });

    expect(anthropicResult.refused).toBe(true);
    expect(openrouterResult.refused).toBe(true);
    expect(anthropicResult.finalText).toBe(openrouterResult.finalText);
  });
});
