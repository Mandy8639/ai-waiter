import { describe, expect, it, vi } from "vitest";
import { buildHistoryMessages, buildRecentToolContext } from "@/lib/ai/history";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";
import {
  toOpenRouterMessages,
  appendAssistantMessage,
  appendToolResultMessage,
  type OpenRouterMessage,
} from "@/lib/ai/providers/openrouter-mapping";
import {
  runConversationLoop,
  type LoopModelResponse,
  type LoopToolOutcome,
} from "@/lib/ai/loop";
import type { ConversationMessage } from "@/lib/ai/conversation";

/**
 * Deterministic, application-level test of the real pipeline that turns
 * persisted conversation history into a model request and back into a
 * tool call — history.ts + system-prompt.ts + openrouter-mapping.ts +
 * loop.ts, exactly as orchestrator.ts composes them (see runTurn() in
 * providers/openrouter.ts), minus the actual network call. Only the
 * model's response is mocked — everything else is the real, unmodified
 * application code. This is deliberately NOT a live-model test: it
 * answers "given the context our application now builds, does a
 * well-behaved model response correctly reach add_item_to_cart with the
 * right arguments?", not "does the real free-tier model behave well,"
 * which is inherently non-deterministic and belongs in the small,
 * separate live E2E suite instead (see docs/ai.md — Phase 25 testing
 * philosophy).
 */

function msg(partial: Partial<ConversationMessage>): ConversationMessage {
  return {
    id: partial.id ?? "id",
    role: partial.role ?? "user",
    content: partial.content ?? "",
    toolName: partial.toolName ?? null,
    toolSuccess: partial.toolSuccess ?? null,
    createdAt: partial.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

const PANEER_ID = "11111111-1111-4111-8111-111111111111";
const MEDIUM_OPTION_ID = "22222222-2222-4222-8222-222222222222";

describe("conversation pipeline: Turn 3 receives Turn 2's tool-derived context and calls add_item_to_cart correctly", () => {
  it("Turn 1 (search_menu) -> Turn 2 (get_menu_item, discovers Spice level/Medium) -> Turn 3 ('Medium please') calls add_item_to_cart with the correct menu item and option UUIDs", async () => {
    // The persisted history exactly as it would exist in the database by
    // the time Turn 3 starts — mirrors the live payload captured during
    // the Phase 2A Turn-3 investigation.
    const history: ConversationMessage[] = [
      msg({ role: "user", content: "What vegetarian dishes do you have?" }),
      msg({
        role: "tool",
        toolName: "search_menu",
        toolSuccess: true,
        content: JSON.stringify({
          ok: true,
          data: {
            items: [{ id: PANEER_ID, name: "Paneer Dosa", price: 9.5 }],
          },
        }),
      }),
      msg({
        role: "assistant",
        content: "We have one vegetarian dish: Paneer Dosa — $9.50.",
      }),
      msg({ role: "user", content: "I'll have the Paneer Dosa" }),
      msg({
        role: "tool",
        toolName: "get_menu_item",
        toolSuccess: true,
        content: JSON.stringify({
          ok: true,
          data: {
            id: PANEER_ID,
            name: "Paneer Dosa",
            modifierGroups: [
              {
                id: "group-1",
                name: "Spice level",
                isRequired: true,
                options: [{ id: MEDIUM_OPTION_ID, name: "Medium" }],
              },
            ],
          },
        }),
      }),
      msg({
        role: "assistant",
        content:
          "The Paneer Dosa requires a spice-level selection. The only option is Medium. Would you like that?",
      }),
    ];

    // --- Exactly what orchestrator.ts#sendAiMessage does for Turn 3 ---
    const historyMessages = buildHistoryMessages(history);
    const recentToolContext = buildRecentToolContext(history);
    const system = buildSystemPrompt({
      restaurantName: "Test Restaurant",
      allowUpselling: true,
      recentToolContext,
    });
    const initialMessages = toOpenRouterMessages(
      system,
      historyMessages,
      "Medium please",
    );

    // Sanity check: the system prompt actually carries the modifier data
    // forward — this is the fix under test, not an assumption.
    expect(system).toContain(PANEER_ID);
    expect(system).toContain(MEDIUM_OPTION_ID);
    expect(system).toContain("Spice level");

    // --- A well-behaved model, now that it has the context, correctly
    // calls add_item_to_cart with the real UUIDs on its first response,
    // then produces a confirmation once the tool succeeds. ---
    const callModel = vi
      .fn<(messages: OpenRouterMessage[]) => Promise<LoopModelResponse>>()
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "call-1",
            name: "add_item_to_cart",
            input: {
              menuItemId: PANEER_ID,
              quantity: 1,
              selectedOptionIds: [MEDIUM_OPTION_ID],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: "text",
            text: "Added the Paneer Dosa with Medium spice to your cart.",
          },
        ],
      });

    const callTool = vi
      .fn<(name: string, args: unknown) => Promise<LoopToolOutcome>>()
      .mockResolvedValue({
        toolName: "add_item_to_cart",
        result: { ok: true, data: { added: true } },
      });

    const result = await runConversationLoop<OpenRouterMessage[]>({
      initialMessages,
      maxToolCalls: 6,
      callModel,
      callTool,
      appendAssistantMessage,
      appendToolResultMessage,
    });

    // The application-level assertion the whole fix exists for: given the
    // preserved context, add_item_to_cart is actually called, with the
    // real menu item UUID and the real modifier option UUID — never the
    // item's name, never a guessed ID.
    expect(callTool).toHaveBeenCalledWith("add_item_to_cart", {
      menuItemId: PANEER_ID,
      quantity: 1,
      selectedOptionIds: [MEDIUM_OPTION_ID],
    });
    expect(result.toolCallCount).toBe(1);
    expect(result.finalText).toBe(
      "Added the Paneer Dosa with Medium spice to your cart.",
    );
    expect(result.refused).toBe(false);
    expect(result.toolLimitExceeded).toBe(false);
  });

  it("without the fix (plain user/assistant replay, no recent tool context), the model request never carries the modifier UUID at all", () => {
    // Negative control: proves the assertion above is actually exercising
    // the fix, not something that would pass regardless. Builds the exact
    // same history through buildHistoryMessages alone (no
    // buildRecentToolContext), matching the pre-fix orchestrator.ts
    // behavior — the modifier option UUID is nowhere in the messages.
    const history: ConversationMessage[] = [
      msg({ role: "user", content: "What vegetarian dishes do you have?" }),
      msg({
        role: "tool",
        toolName: "search_menu",
        toolSuccess: true,
        content: JSON.stringify({
          ok: true,
          data: { items: [{ id: PANEER_ID, name: "Paneer Dosa" }] },
        }),
      }),
      msg({ role: "assistant", content: "We have Paneer Dosa — $9.50." }),
      msg({ role: "user", content: "I'll have the Paneer Dosa" }),
      msg({
        role: "tool",
        toolName: "get_menu_item",
        toolSuccess: true,
        content: JSON.stringify({
          ok: true,
          data: {
            id: PANEER_ID,
            modifierGroups: [
              {
                name: "Spice level",
                options: [{ id: MEDIUM_OPTION_ID, name: "Medium" }],
              },
            ],
          },
        }),
      }),
      msg({
        role: "assistant",
        content: "Would you like the Medium spice level?",
      }),
    ];

    const historyMessages = buildHistoryMessages(history);
    const systemWithoutFix = buildSystemPrompt({
      restaurantName: "Test Restaurant",
      allowUpselling: true,
      // recentToolContext intentionally omitted
    });
    const messagesWithoutFix = toOpenRouterMessages(
      systemWithoutFix,
      historyMessages,
      "Medium please",
    );

    const serialized = JSON.stringify(messagesWithoutFix);
    expect(serialized).not.toContain(MEDIUM_OPTION_ID);
    expect(serialized).not.toContain(PANEER_ID);
  });
});
