import "server-only";
import { z } from "zod";
import { menuTools } from "./menu";
import { cartTools } from "./cart";
import { orderTools } from "./order";
import { serviceTools } from "./service";
import type { ToolContext, ToolResult } from "./types";

/**
 * The complete, fixed tool surface offered to the model — nothing else is
 * callable. Spec section 4 is explicit that there is no `execute_sql`,
 * `query_database`, `admin_supabase`, `arbitrary_rpc`, or
 * `generic_mutation` tool, and there never will be one added here: every
 * entry below is a narrow, named action backed by existing, already-
 * authorized application code (src/lib/cart/, src/lib/orders/).
 */
const allTools = [...menuTools, ...cartTools, ...orderTools, ...serviceTools];

const toolsByName = new Map(allTools.map((tool) => [tool.name, tool]));

/**
 * Provider-neutral tool-definition shape (Batch 9), derived from each
 * tool's own Zod schema (z.toJSONSchema) — one source of truth, not a
 * hand-maintained duplicate. Each provider (src/lib/ai/providers/)
 * reshapes this into its own wire format (Anthropic's
 * {name, description, input_schema} vs. OpenAI-compatible
 * {type: "function", function: {name, description, parameters}}) — this
 * function itself knows nothing about either provider.
 */
export interface NeutralToolDefinition {
  name: string;
  description: string;
  jsonSchema: Record<string, unknown>;
}

export function getToolDefinitions(): NeutralToolDefinition[] {
  return allTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    jsonSchema: z.toJSONSchema(tool.schema, {
      target: "draft-7",
    }) as Record<string, unknown>,
  }));
}

export interface ToolExecutionOutcome {
  toolName: string;
  result: ToolResult;
}

/**
 * Validates the model's tool-call arguments against the tool's own Zod
 * schema (rejecting unknown fields, invalid shapes, oversized strings —
 * spec section 5) BEFORE the tool function ever runs. A model-supplied
 * argument is never trusted just because the model "chose" the tool —
 * this is the actual authorization/validation gate (spec section 24),
 * independent of the model's own behavior.
 */
export async function executeTool(
  toolName: string,
  rawArgs: unknown,
  context: ToolContext,
): Promise<ToolExecutionOutcome> {
  const tool = toolsByName.get(toolName);
  if (!tool) {
    return {
      toolName,
      result: { ok: false, error: `Unknown tool: ${toolName}` },
    };
  }

  const parsed = tool.schema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      toolName,
      result: {
        ok: false,
        error: `Invalid arguments for ${toolName}: ${parsed.error.issues[0]?.message ?? "validation failed"}`,
      },
    };
  }

  try {
    const result = await tool.execute(parsed.data, context);
    return { toolName, result };
  } catch {
    // Never surface a raw exception/stack trace to the model or the
    // customer (spec section 31) — a thrown error here means something
    // unexpected happened in application code, not a business-rule
    // rejection (those come back as `{ ok: false, error }` from the tool
    // itself without throwing).
    return {
      toolName,
      result: {
        ok: false,
        error: "Something went wrong running that action. Please try again.",
      },
    };
  }
}

export { allTools };
