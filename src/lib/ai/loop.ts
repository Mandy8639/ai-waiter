/**
 * The tool-calling loop's pure bookkeeping — deliberately factored out of
 * orchestrator.ts (which has `import "server-only"` and talks to the real
 * Anthropic SDK + real tool registry) so this algorithm is unit-testable
 * with fake `callModel`/`callTool` functions, without a live model or
 * database. orchestrator.ts supplies the real implementations; this file
 * has no knowledge of Anthropic, Supabase, or any I/O at all.
 *
 * This is what actually enforces spec section 26's "maximum tool calls
 * per user turn" — the hard ceiling applies regardless of what the model
 * tries to do, and is verified directly in
 * tests/unit/ai-loop.test.ts (no server-only import needed there either).
 */

export type LoopContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface LoopModelResponse {
  content: LoopContentBlock[];
  /**
   * Optional passthrough of the provider's stop reason. Two values get
   * special handling before the normal tool_use extraction: "refusal"
   * (a safety-classifier decline — stop immediately, never process
   * `content` as though it were a normal reply) and "pause_turn" (a
   * server-tool continuation signal — keep looping without consuming the
   * tool-call budget). Any other value, or omitting the field entirely,
   * falls through to the existing tool_use/text handling unchanged.
   */
  stopReason?: string;
}

export interface LoopToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface LoopToolOutcome {
  toolName: string;
  result: LoopToolResult;
}

export interface RunConversationLoopParams<TMessages> {
  initialMessages: TMessages;
  callModel: (messages: TMessages) => Promise<LoopModelResponse>;
  callTool: (name: string, args: unknown) => Promise<LoopToolOutcome>;
  maxToolCalls: number;
  appendAssistantMessage: (
    messages: TMessages,
    content: LoopContentBlock[],
  ) => TMessages;
  appendToolResultMessage: (
    messages: TMessages,
    results: Array<{ toolUseId: string; content: string; isError: boolean }>,
  ) => TMessages;
}

export interface RunConversationLoopResult {
  finalText: string;
  toolCallCount: number;
  toolLimitExceeded: boolean;
  toolOutcomes: LoopToolOutcome[];
  /** True when the model declined to respond (stop_reason "refusal") — the caller must show a safe decline message, never treat `finalText` as a real reply. */
  refused: boolean;
}

export async function runConversationLoop<TMessages>(
  params: RunConversationLoopParams<TMessages>,
): Promise<RunConversationLoopResult> {
  let messages = params.initialMessages;
  let toolCallCount = 0;
  const toolOutcomes: LoopToolOutcome[] = [];

  // Bounded by construction: every iteration either returns (no tool_use
  // blocks, the limit would be exceeded, or a refusal) or consumes at
  // least one unit of `maxToolCalls` — so under normal operation this
  // never runs more than `maxToolCalls + 1` iterations. "pause_turn" is
  // the one path that loops without consuming that budget (a server-tool
  // continuation signal this app should never actually receive, since it
  // declares no server tools) — `absoluteIterationCeiling` is a defensive
  // hard stop for that path so a misbehaving provider response can never
  // spin this loop forever.
  const absoluteIterationCeiling = params.maxToolCalls * 2 + 10;
  let iterations = 0;

  while (true) {
    iterations += 1;
    if (iterations > absoluteIterationCeiling) {
      return {
        finalText: "",
        toolCallCount,
        toolLimitExceeded: true,
        toolOutcomes,
        refused: false,
      };
    }

    const response = await params.callModel(messages);

    if (response.stopReason === "refusal") {
      return {
        finalText: "",
        toolCallCount,
        toolLimitExceeded: false,
        toolOutcomes,
        refused: true,
      };
    }

    messages = params.appendAssistantMessage(messages, response.content);

    if (response.stopReason === "pause_turn") {
      // Server-tool continuation: keep looping without treating this as a
      // normal reply and without consuming the tool-call budget.
      continue;
    }

    const toolUseBlocks = response.content.filter(
      (block): block is Extract<LoopContentBlock, { type: "tool_use" }> =>
        block.type === "tool_use",
    );

    if (toolUseBlocks.length === 0) {
      const finalText = response.content
        .filter(
          (block): block is Extract<LoopContentBlock, { type: "text" }> =>
            block.type === "text",
        )
        .map((block) => block.text)
        .join("\n")
        .trim();
      return {
        finalText,
        toolCallCount,
        toolLimitExceeded: false,
        toolOutcomes,
        refused: false,
      };
    }

    if (toolCallCount + toolUseBlocks.length > params.maxToolCalls) {
      return {
        finalText: "",
        toolCallCount,
        toolLimitExceeded: true,
        toolOutcomes,
        refused: false,
      };
    }

    const results: Array<{
      toolUseId: string;
      content: string;
      isError: boolean;
    }> = [];
    for (const block of toolUseBlocks) {
      toolCallCount += 1;
      const outcome = await params.callTool(block.name, block.input);
      toolOutcomes.push(outcome);
      results.push({
        toolUseId: block.id,
        content: JSON.stringify(outcome.result),
        isError: !outcome.result.ok,
      });
    }

    messages = params.appendToolResultMessage(messages, results);
  }
}
