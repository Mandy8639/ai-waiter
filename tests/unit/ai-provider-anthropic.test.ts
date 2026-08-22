import { describe, expect, it } from "vitest";
import {
  toAnthropicTools,
  toAnthropicMessages,
  appendAssistantMessage,
  appendToolResultMessage,
  parseAnthropicResponse,
} from "@/lib/ai/providers/anthropic-mapping";
import type { NeutralToolDefinition } from "@/lib/ai/tools/index";

// Pure request/response mapping for the Anthropic provider — no
// "server-only" import here (unlike providers/anthropic.ts, which
// constructs the real SDK client), so this is directly testable without a
// live ANTHROPIC_API_KEY, matching the split established for
// src/lib/env-helpers.ts and src/lib/ai/loop.ts.

const sampleTools: NeutralToolDefinition[] = [
  {
    name: "get_cart",
    description: "Get the customer's cart.",
    jsonSchema: { type: "object", properties: {} },
  },
];

describe("toAnthropicTools", () => {
  it("reshapes the neutral tool definition into Anthropic's input_schema shape", () => {
    const tools = toAnthropicTools(sampleTools);
    expect(tools).toEqual([
      {
        name: "get_cart",
        description: "Get the customer's cart.",
        input_schema: { type: "object", properties: {} },
      },
    ]);
  });
});

describe("toAnthropicMessages", () => {
  it("appends the new user message after prior history, in order", () => {
    const messages = toAnthropicMessages(
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello!" },
      ],
      "what's vegetarian?",
    );
    expect(messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello!" },
      { role: "user", content: "what's vegetarian?" },
    ]);
  });

  it("works with empty history", () => {
    expect(toAnthropicMessages([], "hi")).toEqual([
      { role: "user", content: "hi" },
    ]);
  });
});

describe("appendAssistantMessage / appendToolResultMessage", () => {
  it("appends an assistant turn with the given content blocks", () => {
    const messages = appendAssistantMessage(
      [],
      [{ type: "text", text: "Sure, one moment." }],
    );
    expect(messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "Sure, one moment." }],
      },
    ]);
  });

  it("appends a user turn carrying tool_result blocks", () => {
    const messages = appendToolResultMessage(
      [],
      [{ toolUseId: "call-1", content: '{"ok":true}', isError: false }],
    );
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: '{"ok":true}',
            is_error: false,
          },
        ],
      },
    ]);
  });
});

describe("parseAnthropicResponse", () => {
  it("passes text/tool_use content blocks through unchanged", () => {
    const result = parseAnthropicResponse({
      content: [
        { type: "text", text: "Here you go." },
        { type: "tool_use", id: "call-1", name: "get_cart", input: {} },
      ] as never,
      stop_reason: "end_turn",
    });
    expect(result.content).toEqual([
      { type: "text", text: "Here you go." },
      { type: "tool_use", id: "call-1", name: "get_cart", input: {} },
    ]);
    expect(result.stopReason).toBe("end_turn");
  });

  it("maps a missing stop_reason to undefined", () => {
    const result = parseAnthropicResponse({
      content: [] as never,
      stop_reason: null,
    });
    expect(result.stopReason).toBeUndefined();
  });

  it("passes through 'refusal' as-is — loop.ts is what special-cases it", () => {
    const result = parseAnthropicResponse({
      content: [] as never,
      stop_reason: "refusal",
    });
    expect(result.stopReason).toBe("refusal");
  });
});
