import { describe, expect, it } from "vitest";
import {
  toOpenRouterTools,
  toOpenRouterMessages,
  appendAssistantMessage,
  appendToolResultMessage,
  parseOpenRouterResponse,
} from "@/lib/ai/providers/openrouter-mapping";
import type { NeutralToolDefinition } from "@/lib/ai/tools/index";

// Pure request/response mapping for the OpenRouter provider — no
// "server-only" import, no `fetch` call, so directly testable without a
// live OPENROUTER_API_KEY. Mirrors ai-provider-anthropic.test.ts's
// structure so the two providers' contracts are easy to compare side by
// side.

const sampleTools: NeutralToolDefinition[] = [
  {
    name: "get_cart",
    description: "Get the customer's cart.",
    jsonSchema: { type: "object", properties: {} },
  },
];

describe("toOpenRouterTools", () => {
  it("reshapes the neutral tool definition into OpenAI-compatible function-calling shape", () => {
    const tools = toOpenRouterTools(sampleTools);
    expect(tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_cart",
          description: "Get the customer's cart.",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
  });
});

describe("toOpenRouterMessages", () => {
  it("puts the system prompt first, then history, then the new user message", () => {
    const messages = toOpenRouterMessages(
      "You are the waiter.",
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello!" },
      ],
      "what's vegetarian?",
    );
    expect(messages).toEqual([
      { role: "system", content: "You are the waiter." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello!" },
      { role: "user", content: "what's vegetarian?" },
    ]);
  });
});

describe("appendAssistantMessage", () => {
  it("carries text-only content with no tool_calls field", () => {
    const messages = appendAssistantMessage(
      [],
      [{ type: "text", text: "Sure, one moment." }],
    );
    expect(messages).toEqual([
      { role: "assistant", content: "Sure, one moment." },
    ]);
    expect(messages[0]).not.toHaveProperty("tool_calls");
  });

  it("stringifies tool_use input into function.arguments", () => {
    const messages = appendAssistantMessage(
      [],
      [{ type: "tool_use", id: "call-1", name: "get_cart", input: { a: 1 } }],
    );
    expect(messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "get_cart", arguments: '{"a":1}' },
          },
        ],
      },
    ]);
  });

  it("carries both text and tool_calls when the model returns both", () => {
    const messages = appendAssistantMessage(
      [],
      [
        { type: "text", text: "Checking your cart..." },
        { type: "tool_use", id: "call-1", name: "get_cart", input: {} },
      ],
    );
    expect(messages[0].content).toBe("Checking your cart...");
    expect(messages[0]).toHaveProperty("tool_calls");
  });
});

describe("appendToolResultMessage", () => {
  it("emits one role:'tool' message per result, keyed by tool_call_id", () => {
    const messages = appendToolResultMessage(
      [],
      [
        { toolUseId: "call-1", content: '{"ok":true}', isError: false },
        { toolUseId: "call-2", content: '{"ok":false}', isError: true },
      ],
    );
    expect(messages).toEqual([
      { role: "tool", tool_call_id: "call-1", content: '{"ok":true}' },
      { role: "tool", tool_call_id: "call-2", content: '{"ok":false}' },
    ]);
  });
});

describe("parseOpenRouterResponse", () => {
  it("extracts a text block from message.content", () => {
    const result = parseOpenRouterResponse({
      choices: [
        {
          message: { role: "assistant", content: "Here you go." },
          finish_reason: "stop",
        },
      ],
    });
    expect(result.content).toEqual([{ type: "text", text: "Here you go." }]);
    expect(result.stopReason).toBeUndefined();
  });

  it("parses tool_calls into tool_use blocks with parsed JSON input", () => {
    const result = parseOpenRouterResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "get_cart", arguments: '{"a":1}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(result.content).toEqual([
      { type: "tool_use", id: "call-1", name: "get_cart", input: { a: 1 } },
    ]);
  });

  it("never throws on malformed tool_call arguments — falls back to an empty object", () => {
    const result = parseOpenRouterResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "get_cart", arguments: "{not valid json" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(result.content).toEqual([
      { type: "tool_use", id: "call-1", name: "get_cart", input: {} },
    ]);
  });

  it("maps finish_reason 'content_filter' to stopReason 'refusal'", () => {
    const result = parseOpenRouterResponse({
      choices: [
        {
          message: { role: "assistant", content: null },
          finish_reason: "content_filter",
        },
      ],
    });
    expect(result.stopReason).toBe("refusal");
  });

  it("never throws on an empty choices array", () => {
    const result = parseOpenRouterResponse({ choices: [] });
    expect(result.content).toEqual([]);
    expect(result.stopReason).toBeUndefined();
  });
});
