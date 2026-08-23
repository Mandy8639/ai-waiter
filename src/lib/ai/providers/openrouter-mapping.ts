import type { LoopContentBlock, LoopModelResponse } from "../loop";
import type { NeutralToolDefinition } from "../tools/index";

/**
 * Pure OpenRouter (OpenAI-compatible Chat Completions) request/response
 * mapping — no `import "server-only"`, no network access, so this file is
 * directly unit-testable without a live key, matching
 * providers/anthropic-mapping.ts's split from the real client in
 * providers/openrouter.ts.
 */

export interface OpenRouterToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type OpenRouterMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenRouterToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export interface OpenRouterTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenRouterChatResponse {
  choices: Array<{
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenRouterToolCall[];
    };
    finish_reason: string | null;
  }>;
}

export function toOpenRouterTools(
  tools: NeutralToolDefinition[],
): OpenRouterTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchema,
    },
  }));
}

export function toOpenRouterMessages(
  system: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  userMessage: string,
): OpenRouterMessage[] {
  return [
    { role: "system", content: system },
    ...history.map((m): OpenRouterMessage => ({
      role: m.role,
      content: m.content,
    })),
    { role: "user", content: userMessage },
  ];
}

export function appendAssistantMessage(
  messages: OpenRouterMessage[],
  content: LoopContentBlock[],
): OpenRouterMessage[] {
  const textContent = content
    .filter(
      (b): b is Extract<LoopContentBlock, { type: "text" }> =>
        b.type === "text",
    )
    .map((b) => b.text)
    .join("\n");

  const toolCalls = content
    .filter(
      (b): b is Extract<LoopContentBlock, { type: "tool_use" }> =>
        b.type === "tool_use",
    )
    .map((b): OpenRouterToolCall => ({
      id: b.id,
      type: "function",
      function: { name: b.name, arguments: JSON.stringify(b.input) },
    }));

  return [
    ...messages,
    {
      role: "assistant",
      content: textContent || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
  ];
}

/** Injects a plain user-role instruction message — used by the menu-factuality guard's one corrective retry (see loop.ts#TextAcceptanceGuard). Never persisted to ai_conversation_messages; it only exists transiently within this turn's in-flight message list. */
export function appendUserMessage(
  messages: OpenRouterMessage[],
  text: string,
): OpenRouterMessage[] {
  return [...messages, { role: "user", content: text }];
}

export function appendToolResultMessage(
  messages: OpenRouterMessage[],
  results: Array<{ toolUseId: string; content: string; isError: boolean }>,
): OpenRouterMessage[] {
  return [
    ...messages,
    ...results.map((r): OpenRouterMessage => ({
      role: "tool",
      tool_call_id: r.toolUseId,
      content: r.content,
    })),
  ];
}

/**
 * "content_filter" (OpenAI-compatible finish_reason for a safety-declined
 * response) maps to loop.ts's "refusal" stopReason — the same
 * stop-immediately, never-treat-content-as-a-reply handling Anthropic's
 * native "refusal" already gets, so refusal protection is uniform across
 * providers (spec requirement 16) without loop.ts knowing two providers
 * exist. "tool_calls"/"stop"/"length"/anything else falls through to
 * loop.ts's normal tool_use/text extraction unchanged — this app never
 * emits "pause_turn" (an Anthropic-specific server-tool signal), so no
 * mapping for it is needed here.
 *
 * A malformed tool_call.function.arguments string (a misbehaving model
 * emitting invalid JSON) never throws — it falls back to an empty object,
 * which tools/index.ts#executeTool's own Zod validation then rejects with
 * a normal "Invalid arguments" result, the same safe path a legitimately
 * wrong argument shape already takes.
 */
export function parseOpenRouterResponse(
  response: OpenRouterChatResponse,
): LoopModelResponse {
  const choice = response.choices[0];
  const message = choice?.message;

  const blocks: LoopContentBlock[] = [];
  if (message?.content) {
    blocks.push({ type: "text", text: message.content });
  }
  for (const toolCall of message?.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(toolCall.function.arguments);
    } catch {
      input = {};
    }
    blocks.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.function.name,
      input,
    });
  }

  return {
    content: blocks,
    stopReason:
      choice?.finish_reason === "content_filter" ? "refusal" : undefined,
  };
}
