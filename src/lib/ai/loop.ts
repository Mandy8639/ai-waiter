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
  /**
   * Which model actually produced this response, when the provider
   * reports it. Differs from the configured model when a preference list
   * fell back to a later entry — the caller logs this rather than the
   * configured value, so a log line never names a model that didn't run.
   */
  servedModel?: string;
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

/**
 * Optional, generic hook for "don't accept a text-only reply unless some
 * condition on this turn's tool outcomes holds" — loop.ts has no idea what
 * that condition IS (menu-factuality is defined in
 * tools/menu-fact-detection.ts); it just knows how to give the model one
 * bounded corrective round before falling back safely. Reuses the same
 * `toolOutcomes` the loop already accumulates — no parallel state.
 */
export interface TextAcceptanceGuard<TMessages> {
  /**
   * Identifies which guard rejected a reply, so the caller can pick the
   * matching customer-facing fallback and log outcome without loop.ts
   * knowing anything about menus, carts, or logging.
   */
  id: string;
  /**
   * True = accept the text-only reply as final. False = needs correction.
   * Receives the candidate reply as well as the turn's tool outcomes:
   * some guards key off what the model just said (see
   * tools/cart-fact-detection.ts) rather than off the customer's message.
   */
  shouldAccept: (toolOutcomes: LoopToolOutcome[], finalText: string) => boolean;
  /** Injected as one corrective message before the single retry round. */
  correctiveInstruction: string;
  appendUserMessage: (messages: TMessages, text: string) => TMessages;
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
  /**
   * Omitted or empty for turns that need no guarding. Evaluated in order;
   * the first guard to reject a reply owns the single corrective round, so
   * list the more specific guard first if two could ever fire together.
   */
  textAcceptanceGuards?: Array<TextAcceptanceGuard<TMessages>>;
}

export interface RunConversationLoopResult {
  finalText: string;
  toolCallCount: number;
  toolLimitExceeded: boolean;
  toolOutcomes: LoopToolOutcome[];
  /** True when the model declined to respond (stop_reason "refusal") — the caller must show a safe decline message, never treat `finalText` as a real reply. */
  refused: boolean;
  /** True when a text-acceptance guard rejected the reply twice in a row (the one bounded retry didn't help) — the caller must show its own safe fallback, `finalText` is empty. */
  guardCorrectionExhausted: boolean;
  /** Which guard's `id` exhausted its retry, when `guardCorrectionExhausted` is true — lets the caller choose the matching fallback text. */
  exhaustedGuardId?: string;
  /**
   * The model that served the most recent response of this turn, when the
   * provider reports one. A turn can span several model calls, and under a
   * preference list they need not all be served by the same model, so this
   * is the last one — the model that produced the reply the customer sees.
   */
  servedModel?: string;
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
  // The text-acceptance guards' one bounded corrective round — separate
  // from `maxToolCalls`/`absoluteIterationCeiling` since it's not a tool
  // call, but still hard-capped at exactly one retry (shared across all
  // guards) so a model that keeps ignoring the correction can never spin
  // this loop.
  let guardRetryUsed = false;
  // The last model to actually serve a response this turn — see
  // RunConversationLoopResult#servedModel for why the last one wins.
  let servedModel: string | undefined;

  while (true) {
    iterations += 1;
    if (iterations > absoluteIterationCeiling) {
      return {
        finalText: "",
        toolCallCount,
        toolLimitExceeded: true,
        toolOutcomes,
        refused: false,
        guardCorrectionExhausted: false,
        servedModel,
      };
    }

    const response = await params.callModel(messages);
    servedModel = response.servedModel ?? servedModel;

    if (response.stopReason === "refusal") {
      return {
        finalText: "",
        toolCallCount,
        toolLimitExceeded: false,
        toolOutcomes,
        refused: true,
        guardCorrectionExhausted: false,
        servedModel,
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

      // The single retry round is shared across all guards, not one per
      // guard: a model that ignores one corrective note is not made more
      // reliable by stacking another, and per-guard retries would let a
      // turn call the model once per guard.
      const rejectingGuard = (params.textAcceptanceGuards ?? []).find(
        (candidate) => !candidate.shouldAccept(toolOutcomes, finalText),
      );
      if (rejectingGuard) {
        if (!guardRetryUsed) {
          // One bounded corrective round: nudge the model, then let the
          // while loop run again — this does NOT consume the tool-call
          // budget, matching how "pause_turn" also loops without doing so.
          guardRetryUsed = true;
          messages = rejectingGuard.appendUserMessage(
            messages,
            rejectingGuard.correctiveInstruction,
          );
          continue;
        }
        // The retry didn't help — fail safely rather than looping or
        // calling the model a third time for this condition.
        return {
          finalText: "",
          toolCallCount,
          toolLimitExceeded: false,
          toolOutcomes,
          refused: false,
          guardCorrectionExhausted: true,
          exhaustedGuardId: rejectingGuard.id,
          servedModel,
        };
      }

      return {
        finalText,
        toolCallCount,
        toolLimitExceeded: false,
        toolOutcomes,
        refused: false,
        guardCorrectionExhausted: false,
        servedModel,
      };
    }

    if (toolCallCount + toolUseBlocks.length > params.maxToolCalls) {
      return {
        finalText: "",
        toolCallCount,
        toolLimitExceeded: true,
        toolOutcomes,
        refused: false,
        guardCorrectionExhausted: false,
        servedModel,
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
