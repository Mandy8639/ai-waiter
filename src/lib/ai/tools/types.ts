import "server-only";
import type { z } from "zod";

/**
 * Everything a tool needs about "who is asking" — derived server-side by
 * the orchestrator from the authenticated customer session BEFORE any
 * tool runs, never from a model-supplied argument. No tool schema in this
 * codebase has a restaurant_id, table_id, or customer_session_id field —
 * this is why: there's nothing for the model to tamper with, because the
 * context always comes from here, not from its own output.
 *
 * See docs/security.md#ai-tool-authorization.
 */
export interface ToolContext {
  restaurantId: string;
  restaurantSlug: string;
  customerSessionId: string;
  /**
   * Generated once per customer turn (src/lib/ai/orchestrator.ts), before
   * the model is called — reused for every submit_order tool invocation
   * within that turn, so a model retry (or a duplicate tool call in the
   * same turn) collapses into the existing submit_order() idempotency
   * mechanism rather than creating a second, AI-specific one (spec
   * section 14).
   */
  turnIdempotencyKey: string;
}

export interface ToolResult {
  ok: boolean;
  /** Structured, JSON-serializable — never raw SQL rows, never a full table dump. */
  data?: unknown;
  /** Customer-safe message only — same discipline as toFriendlyError()/parseOrderError() elsewhere in this codebase. */
  error?: string;
}

export interface ToolDefinition<Args = unknown> {
  name: string;
  /** Shown to the model — describes what the tool does and when to use it, not how it's implemented. */
  description: string;
  schema: z.ZodType<Args>;
  /** JSON Schema handed to the model — derived from `schema` at registration time, see tools/index.ts. */
  execute: (args: Args, context: ToolContext) => Promise<ToolResult>;
}
