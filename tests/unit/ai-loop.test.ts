import { describe, expect, it, vi } from "vitest";
import {
  runConversationLoop,
  type LoopModelResponse,
  type LoopToolOutcome,
} from "@/lib/ai/loop";

type FakeMessage = { role: string; note: string };

function fakeParams(
  overrides: Partial<
    Parameters<typeof runConversationLoop<FakeMessage[]>>[0]
  > = {},
) {
  return {
    initialMessages: [] as FakeMessage[],
    maxToolCalls: 6,
    callModel: vi.fn(),
    callTool: vi.fn(),
    appendAssistantMessage: (messages: FakeMessage[]) => [
      ...messages,
      { role: "assistant", note: "assistant-turn" },
    ],
    appendToolResultMessage: (messages: FakeMessage[]) => [
      ...messages,
      { role: "user", note: "tool-results" },
    ],
    ...overrides,
  };
}

describe("runConversationLoop", () => {
  it("returns the model's text directly when it makes no tool calls", async () => {
    const callModel = vi
      .fn<() => Promise<LoopModelResponse>>()
      .mockResolvedValue({
        content: [{ type: "text", text: "Hello! What can I get you?" }],
      });
    const callTool = vi.fn();

    const result = await runConversationLoop(
      fakeParams({ callModel, callTool }),
    );

    expect(result.finalText).toBe("Hello! What can I get you?");
    expect(result.toolCallCount).toBe(0);
    expect(result.toolLimitExceeded).toBe(false);
    expect(callTool).not.toHaveBeenCalled();
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("executes a tool call, feeds the result back, and returns the follow-up text", async () => {
    const callModel = vi
      .fn<() => Promise<LoopModelResponse>>()
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "call-1", name: "get_cart", input: {} },
        ],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Your cart has 2 items." }],
      });
    const callTool = vi.fn<() => Promise<LoopToolOutcome>>().mockResolvedValue({
      toolName: "get_cart",
      result: { ok: true, data: { lines: [] } },
    });

    const result = await runConversationLoop(
      fakeParams({ callModel, callTool }),
    );

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith("get_cart", {});
    expect(result.toolCallCount).toBe(1);
    expect(result.finalText).toBe("Your cart has 2 items.");
    expect(result.toolOutcomes).toHaveLength(1);
    expect(result.toolOutcomes[0].result.ok).toBe(true);
  });

  it("counts multiple tool calls within a single model turn correctly", async () => {
    const callModel = vi
      .fn<() => Promise<LoopModelResponse>>()
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "call-1", name: "search_menu", input: {} },
          {
            type: "tool_use",
            id: "call-2",
            name: "get_restaurant_info",
            input: {},
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Here's what I found." }],
      });
    const callTool = vi.fn<() => Promise<LoopToolOutcome>>().mockResolvedValue({
      toolName: "search_menu",
      result: { ok: true, data: [] },
    });

    const result = await runConversationLoop(
      fakeParams({ callModel, callTool }),
    );

    expect(callTool).toHaveBeenCalledTimes(2);
    expect(result.toolCallCount).toBe(2);
  });

  it("stops and reports toolLimitExceeded once the per-turn tool call budget would be exceeded, without calling the model again", async () => {
    const callModel = vi
      .fn<() => Promise<LoopModelResponse>>()
      .mockResolvedValue({
        content: [
          { type: "tool_use", id: "call-x", name: "search_menu", input: {} },
        ],
      });
    const callTool = vi.fn<() => Promise<LoopToolOutcome>>().mockResolvedValue({
      toolName: "search_menu",
      result: { ok: true, data: [] },
    });

    const result = await runConversationLoop(
      fakeParams({ callModel, callTool, maxToolCalls: 2 }),
    );

    expect(result.toolLimitExceeded).toBe(true);
    // Exactly 2 tool calls executed (the budget), then the loop stops
    // before a 3rd would be attempted — callModel is called once per
    // round (3 rounds: 2 successful + 1 that would have exceeded), not
    // unboundedly.
    expect(result.toolCallCount).toBe(2);
    expect(callModel.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("never calls the model more than maxToolCalls + 1 times, even if the fake model always requests another tool call (infinite-loop protection, spec section 26)", async () => {
    const callModel = vi
      .fn<() => Promise<LoopModelResponse>>()
      .mockResolvedValue({
        content: [
          { type: "tool_use", id: "call-loop", name: "get_cart", input: {} },
        ],
      });
    const callTool = vi.fn<() => Promise<LoopToolOutcome>>().mockResolvedValue({
      toolName: "get_cart",
      result: { ok: true, data: {} },
    });

    const maxToolCalls = 4;
    await runConversationLoop(
      fakeParams({ callModel, callTool, maxToolCalls }),
    );

    expect(callModel.mock.calls.length).toBeLessThanOrEqual(maxToolCalls + 1);
  });

  it("records a failed tool call (ok: false) as an error result, without throwing", async () => {
    const callModel = vi
      .fn<() => Promise<LoopModelResponse>>()
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "call-1",
            name: "add_item_to_cart",
            input: { menuItemId: "x" },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "That item isn't available." }],
      });
    const callTool = vi.fn<() => Promise<LoopToolOutcome>>().mockResolvedValue({
      toolName: "add_item_to_cart",
      result: { ok: false, error: "This item is currently unavailable." },
    });

    const result = await runConversationLoop(
      fakeParams({ callModel, callTool }),
    );

    expect(result.toolOutcomes[0].result.ok).toBe(false);
    expect(result.finalText).toBe("That item isn't available.");
  });

  it("recovers from a failed tool call: the model tries a different tool call next and succeeds, within the same turn", async () => {
    // Mirrors a real live pattern observed during Phase 2A: a first
    // get_menu_item call fails (stale/wrong id), the model re-searches,
    // then succeeds — recovery to success, not just "doesn't crash."
    const callModel = vi
      .fn<() => Promise<LoopModelResponse>>()
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "call-1",
            name: "get_menu_item",
            input: { menuItemId: "stale-id" },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "call-2",
            name: "search_menu",
            input: { query: "Paneer Dosa" },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Found it — Paneer Dosa is $9.50." }],
      });
    const callTool = vi
      .fn<() => Promise<LoopToolOutcome>>()
      .mockResolvedValueOnce({
        toolName: "get_menu_item",
        result: {
          ok: false,
          error: "That item isn't on the menu (or isn't currently available).",
        },
      })
      .mockResolvedValueOnce({
        toolName: "search_menu",
        result: {
          ok: true,
          data: { items: [{ id: "real-id", name: "Paneer Dosa" }] },
        },
      });

    const result = await runConversationLoop(
      fakeParams({ callModel, callTool }),
    );

    expect(result.toolOutcomes).toHaveLength(2);
    expect(result.toolOutcomes[0].result.ok).toBe(false);
    expect(result.toolOutcomes[1].result.ok).toBe(true);
    expect(result.toolCallCount).toBe(2);
    expect(result.finalText).toBe("Found it — Paneer Dosa is $9.50.");
    expect(callModel).toHaveBeenCalledTimes(3);
  });

  it("passes accumulated messages through appendAssistantMessage/appendToolResultMessage in order", async () => {
    const callModel = vi
      .fn<() => Promise<LoopModelResponse>>()
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "call-1", name: "get_cart", input: {} },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Done." }] });
    const callTool = vi
      .fn<() => Promise<LoopToolOutcome>>()
      .mockResolvedValue({ toolName: "get_cart", result: { ok: true } });

    const seenMessageLengths: number[] = [];
    const params = fakeParams({
      callModel: vi.fn(async (messages: FakeMessage[]) => {
        seenMessageLengths.push(messages.length);
        return callModel();
      }),
      callTool,
    });

    await runConversationLoop(params);

    // First callModel invocation sees the initial (empty) messages; the
    // second sees the assistant turn + tool-result turn appended in
    // between — proves the accumulation actually threads through.
    expect(seenMessageLengths).toEqual([0, 2]);
  });

  it("stops immediately and sets refused:true on stop_reason 'refusal', without treating content as a normal reply", async () => {
    const callModel = vi
      .fn<() => Promise<LoopModelResponse>>()
      .mockResolvedValue({
        content: [{ type: "text", text: "should never be used" }],
        stopReason: "refusal",
      });
    const callTool = vi.fn();

    const result = await runConversationLoop(
      fakeParams({ callModel, callTool }),
    );

    expect(result.refused).toBe(true);
    expect(result.finalText).toBe("");
    expect(callTool).not.toHaveBeenCalled();
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("continues the loop on stop_reason 'pause_turn' without consuming the tool-call budget", async () => {
    const callModel = vi
      .fn<() => Promise<LoopModelResponse>>()
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "continuing..." }],
        stopReason: "pause_turn",
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Here's the final answer." }],
      });
    const callTool = vi.fn();

    const result = await runConversationLoop(
      fakeParams({ callModel, callTool, maxToolCalls: 2 }),
    );

    expect(result.refused).toBe(false);
    expect(result.toolCallCount).toBe(0);
    expect(result.toolLimitExceeded).toBe(false);
    expect(result.finalText).toBe("Here's the final answer.");
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it("has a defensive absolute iteration ceiling even if the model keeps returning pause_turn forever", async () => {
    const callModel = vi
      .fn<() => Promise<LoopModelResponse>>()
      .mockResolvedValue({
        content: [{ type: "text", text: "still going..." }],
        stopReason: "pause_turn",
      });
    const callTool = vi.fn();

    const result = await runConversationLoop(
      fakeParams({ callModel, callTool, maxToolCalls: 3 }),
    );

    expect(result.toolLimitExceeded).toBe(true);
    expect(callModel.mock.calls.length).toBeLessThanOrEqual(3 * 2 + 10);
  });

  describe("textAcceptanceGuards (menu-factuality and cart-state guard integration)", () => {
    const appendUserMessage = (messages: FakeMessage[], text: string) => [
      ...messages,
      { role: "user", note: text },
    ];

    it("C.1 flagged turn + no tool call at all -> one corrective retry, then accepts the follow-up text", async () => {
      const callModel = vi
        .fn<() => Promise<LoopModelResponse>>()
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "Paneer Tikka is $8.99." }],
        })
        .mockResolvedValueOnce({
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: "get_menu_item",
              input: {},
            },
          ],
        })
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "It's really $8.99, confirmed." }],
        });
      const callTool = vi
        .fn<() => Promise<LoopToolOutcome>>()
        .mockResolvedValue({
          toolName: "get_menu_item",
          result: { ok: true, data: {} },
        });
      const shouldAccept = vi.fn((outcomes: LoopToolOutcome[]) =>
        outcomes.some((o) => o.toolName === "get_menu_item" && o.result.ok),
      );

      const result = await runConversationLoop(
        fakeParams({
          callModel,
          callTool,
          textAcceptanceGuards: [
            {
              id: "menu_fact",
              shouldAccept,
              correctiveInstruction: "please use a menu tool",
              appendUserMessage,
            },
          ],
        }),
      );

      expect(callModel).toHaveBeenCalledTimes(3);
      expect(result.finalText).toBe("It's really $8.99, confirmed.");
      expect(result.guardCorrectionExhausted).toBe(false);
    });

    it("C.7 model still refuses to call a menu tool after the corrective retry -> bounded safe response, not an infinite loop", async () => {
      const callModel = vi
        .fn<() => Promise<LoopModelResponse>>()
        .mockResolvedValue({
          content: [{ type: "text", text: "It's around $8, I think." }],
        });
      const callTool = vi.fn();
      const shouldAccept = vi.fn(() => false);

      const result = await runConversationLoop(
        fakeParams({
          callModel,
          callTool,
          textAcceptanceGuards: [
            {
              id: "menu_fact",
              shouldAccept,
              correctiveInstruction: "please use a menu tool",
              appendUserMessage,
            },
          ],
        }),
      );

      // Exactly one corrective retry: 2 calls total, never more.
      expect(callModel).toHaveBeenCalledTimes(2);
      expect(result.guardCorrectionExhausted).toBe(true);
      expect(result.finalText).toBe("");
      expect(callTool).not.toHaveBeenCalled();
    });

    it("C.8 non-flagged turn (no textAcceptanceGuards passed) -> existing text-only behavior is completely unchanged", async () => {
      const callModel = vi
        .fn<() => Promise<LoopModelResponse>>()
        .mockResolvedValue({
          content: [{ type: "text", text: "You're welcome!" }],
        });
      const callTool = vi.fn();

      const result = await runConversationLoop(
        fakeParams({ callModel, callTool }),
      );

      expect(callModel).toHaveBeenCalledTimes(1);
      expect(result.finalText).toBe("You're welcome!");
      expect(result.guardCorrectionExhausted).toBe(false);
    });

    it("accepts immediately, with no retry, when the guard is satisfied on the first attempt", async () => {
      const callModel = vi
        .fn<() => Promise<LoopModelResponse>>()
        .mockResolvedValueOnce({
          content: [
            { type: "tool_use", id: "call-1", name: "search_menu", input: {} },
          ],
        })
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "Here's what's vegetarian." }],
        });
      const callTool = vi
        .fn<() => Promise<LoopToolOutcome>>()
        .mockResolvedValue({
          toolName: "search_menu",
          result: { ok: true, data: [] },
        });
      const shouldAccept = vi.fn((outcomes: LoopToolOutcome[]) =>
        outcomes.some((o) => o.toolName === "search_menu" && o.result.ok),
      );

      const result = await runConversationLoop(
        fakeParams({
          callModel,
          callTool,
          textAcceptanceGuards: [
            {
              id: "menu_fact",
              shouldAccept,
              correctiveInstruction: "please use a menu tool",
              appendUserMessage,
            },
          ],
        }),
      );

      expect(callModel).toHaveBeenCalledTimes(2);
      expect(result.finalText).toBe("Here's what's vegetarian.");
      expect(result.guardCorrectionExhausted).toBe(false);
    });

    it("passes the candidate reply to shouldAccept, so a guard can key off what the model said", async () => {
      const callModel = vi
        .fn<() => Promise<LoopModelResponse>>()
        .mockResolvedValue({
          content: [{ type: "text", text: "you now have two dosas" }],
        });
      const shouldAccept = vi.fn(() => true);

      await runConversationLoop(
        fakeParams({
          callModel,
          callTool: vi.fn(),
          textAcceptanceGuards: [
            {
              id: "cart_state",
              shouldAccept,
              correctiveInstruction: "read the cart",
              appendUserMessage,
            },
          ],
        }),
      );

      expect(shouldAccept).toHaveBeenCalledWith([], "you now have two dosas");
    });

    it("the first rejecting guard owns the single corrective round", async () => {
      const callModel = vi
        .fn<() => Promise<LoopModelResponse>>()
        .mockResolvedValue({ content: [{ type: "text", text: "nope" }] });
      const appended: string[] = [];
      const recordingAppend = (messages: FakeMessage[], text: string) => {
        appended.push(text);
        return appendUserMessage(messages, text);
      };

      const result = await runConversationLoop(
        fakeParams({
          callModel,
          callTool: vi.fn(),
          textAcceptanceGuards: [
            {
              id: "menu_fact",
              shouldAccept: () => true,
              correctiveInstruction: "use a menu tool",
              appendUserMessage: recordingAppend,
            },
            {
              id: "cart_state",
              shouldAccept: () => false,
              correctiveInstruction: "read the cart",
              appendUserMessage: recordingAppend,
            },
          ],
        }),
      );

      // Only the guard that actually rejected gets to inject its note.
      expect(appended).toEqual(["read the cart"]);
      expect(result.exhaustedGuardId).toBe("cart_state");
      expect(result.guardCorrectionExhausted).toBe(true);
    });

    it("shares one retry across guards rather than one retry each", async () => {
      const callModel = vi
        .fn<() => Promise<LoopModelResponse>>()
        .mockResolvedValue({ content: [{ type: "text", text: "nope" }] });

      const result = await runConversationLoop(
        fakeParams({
          callModel,
          callTool: vi.fn(),
          textAcceptanceGuards: [
            {
              id: "menu_fact",
              shouldAccept: () => false,
              correctiveInstruction: "use a menu tool",
              appendUserMessage,
            },
            {
              id: "cart_state",
              shouldAccept: () => false,
              correctiveInstruction: "read the cart",
              appendUserMessage,
            },
          ],
        }),
      );

      // Two guards, still exactly one corrective retry: 2 model calls.
      expect(callModel).toHaveBeenCalledTimes(2);
      expect(result.exhaustedGuardId).toBe("menu_fact");
    });

    it("leaves exhaustedGuardId undefined on an accepted reply", async () => {
      const result = await runConversationLoop(
        fakeParams({
          callModel: vi
            .fn<() => Promise<LoopModelResponse>>()
            .mockResolvedValue({ content: [{ type: "text", text: "hi" }] }),
          callTool: vi.fn(),
          textAcceptanceGuards: [
            {
              id: "cart_state",
              shouldAccept: () => true,
              correctiveInstruction: "read the cart",
              appendUserMessage,
            },
          ],
        }),
      );

      expect(result.guardCorrectionExhausted).toBe(false);
      expect(result.exhaustedGuardId).toBeUndefined();
    });
  });
});
