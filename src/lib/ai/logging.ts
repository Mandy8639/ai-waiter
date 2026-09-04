import "server-only";
import { createHash } from "node:crypto";
import type { AiErrorCategory } from "./provider-error";

/**
 * Structured, PII-minimal observability for the AI layer (spec section
 * 38). This project has no external logging/metrics service (see
 * docs/development.md) — `console.log` with a consistent JSON shape is
 * the pragmatic choice at this scale, and is a drop-in source for any
 * real log pipeline later (structured JSON lines, not formatted text).
 *
 * Deliberately never logs: message content, customer notes, API keys, or
 * the raw customer_session_id (hashed below, so log lines can be
 * correlated to "the same session" without recording a value that itself
 * identifies a person/session in a durable log store).
 */
function hashSessionId(customerSessionId: string): string {
  return createHash("sha256")
    .update(customerSessionId)
    .digest("hex")
    .slice(0, 16);
}

export interface AiTurnLogFields {
  restaurantId: string;
  customerSessionId: string;
  toolCallCount: number;
  latencyMs: number;
  model: string;
  /** Which backend served this turn — added alongside the provider abstraction so logs stay meaningful when AI_PROVIDER differs between dev and prod. */
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  outcome:
    | "ok"
    | "rate_limited"
    | "provider_error"
    | "tool_limit_exceeded"
    | "unconfigured"
    | "refused"
    | "menu_fact_guard_exhausted"
    | "cart_state_guard_exhausted";
}

export function logAiTurn(fields: AiTurnLogFields): void {
  console.log(
    JSON.stringify({
      event: "ai_turn",
      timestamp: new Date().toISOString(),
      restaurant_id: fields.restaurantId,
      session: hashSessionId(fields.customerSessionId),
      tool_call_count: fields.toolCallCount,
      latency_ms: fields.latencyMs,
      model: fields.model,
      provider: fields.provider,
      input_tokens: fields.inputTokens,
      output_tokens: fields.outputTokens,
      outcome: fields.outcome,
    }),
  );
}

export interface AiToolLogFields {
  restaurantId: string;
  customerSessionId: string;
  toolName: string;
  success: boolean;
  latencyMs: number;
}

export function logAiToolCall(fields: AiToolLogFields): void {
  console.log(
    JSON.stringify({
      event: "ai_tool_call",
      timestamp: new Date().toISOString(),
      restaurant_id: fields.restaurantId,
      session: hashSessionId(fields.customerSessionId),
      tool_name: fields.toolName,
      success: fields.success,
      latency_ms: fields.latencyMs,
    }),
  );
}

export function logAiError(fields: {
  restaurantId?: string;
  customerSessionId?: string;
  category: AiErrorCategory;
  message: string;
}): void {
  console.error(
    JSON.stringify({
      event: "ai_error",
      timestamp: new Date().toISOString(),
      restaurant_id: fields.restaurantId,
      session: fields.customerSessionId
        ? hashSessionId(fields.customerSessionId)
        : undefined,
      category: fields.category,
      message: fields.message,
    }),
  );
}
