import type Anthropic from "@anthropic-ai/sdk";
import type { LoopContentBlock, LoopModelResponse } from "../loop";
import type { NeutralToolDefinition } from "../tools/index";

/**
 * Pure Anthropic request/response mapping — deliberately free of `import
 * "server-only"` (unlike providers/anthropic.ts, which constructs the real
 * SDK client) so this file's logic is directly unit-testable, matching the
 * same split established for src/lib/env-helpers.ts and src/lib/ai/loop.ts
 * in earlier batches. Type-only imports from `@anthropic-ai/sdk` are safe
 * here — the SDK package itself has no `server-only` guard; only this
 * codebase's own files do.
 */

export type AnthropicMessages = Anthropic.Beta.BetaMessageParam[];

export function toAnthropicTools(
  tools: NeutralToolDefinition[],
): Anthropic.Beta.BetaTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.jsonSchema as Anthropic.Beta.BetaTool.InputSchema,
  }));
}

export function toAnthropicMessages(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  userMessage: string,
): AnthropicMessages {
  return [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: userMessage },
  ];
}

export function appendAssistantMessage(
  messages: AnthropicMessages,
  content: LoopContentBlock[],
): AnthropicMessages {
  return [
    ...messages,
    {
      role: "assistant",
      content: content as unknown as Anthropic.Beta.BetaMessageParam["content"],
    },
  ];
}

export function appendToolResultMessage(
  messages: AnthropicMessages,
  results: Array<{ toolUseId: string; content: string; isError: boolean }>,
): AnthropicMessages {
  return [
    ...messages,
    {
      role: "user",
      content: results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.toolUseId,
        content: r.content,
        is_error: r.isError,
      })),
    },
  ];
}

/**
 * response.content already arrives as Anthropic's own text/tool_use block
 * shapes, structurally identical to LoopContentBlock — this is a type
 * assertion, not a data transform. response.stop_reason passes straight
 * through as LoopModelResponse.stopReason; loop.ts already knows what to
 * do with "refusal"/"pause_turn"/anything else.
 */
export function parseAnthropicResponse(
  response: Pick<Anthropic.Beta.BetaMessage, "content" | "stop_reason">,
): LoopModelResponse {
  return {
    content: response.content as unknown as LoopContentBlock[],
    stopReason: response.stop_reason ?? undefined,
  };
}
