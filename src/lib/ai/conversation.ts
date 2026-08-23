import "server-only";
import { createClient } from "@/lib/supabase/server";
import { aiConfig } from "./config";

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolName: string | null;
  toolSuccess: boolean | null;
  createdAt: string;
}

/** The trailing window of messages sent back to the model as context — bounded (spec section 47: never the whole history, never the whole menu). Ordered oldest-first for the model. */
export async function getRecentMessages(
  customerSessionId: string,
): Promise<ConversationMessage[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("ai_conversation_messages")
    .select("id, role, content, tool_name, tool_success, created_at")
    .eq("customer_session_id", customerSessionId)
    .order("created_at", { ascending: false })
    .limit(aiConfig.maxHistoryMessages);

  return (data ?? []).reverse().map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    toolName: row.tool_name,
    toolSuccess: row.tool_success,
    createdAt: row.created_at,
  }));
}

/**
 * The user-role message that triggered the CURRENT turn — always the
 * newest one, since insertMessage(..., "user", ...) runs once per turn,
 * before any tool executes (see orchestrator.ts#sendAiMessage). Used by
 * the submit_order confirmation gate (order-confirmation.ts) to detect
 * "this confirmation was established in an earlier turn, not this one."
 */
export async function getLatestUserMessageTimestamp(
  customerSessionId: string,
): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("ai_conversation_messages")
    .select("created_at")
    .eq("customer_session_id", customerSessionId)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.created_at ?? null;
}

/**
 * The most recent SUCCESSFUL call to a given tool for this session,
 * regardless of the display/context window (aiConfig.maxHistoryMessages)
 * — the confirmation gate must still work even if the customer has
 * chatted enough since to push the original request_order_confirmation
 * call out of what's shown back to the model.
 *
 * `before`, when given, filters to calls strictly earlier than that ISO
 * timestamp — pass the current turn's own user-message timestamp
 * (getLatestUserMessageTimestamp) so this returns "the latest
 * confirmation from a PRIOR turn," never one the model just made in the
 * turn that's trying to use it. Filtering at the query level (rather than
 * fetching the single global latest and checking client-side) means a
 * same-turn re-verification call never shadows a still-valid earlier
 * confirmation — the DB itself only ever returns a qualifying row.
 */
export async function getLatestSuccessfulToolCall(
  customerSessionId: string,
  toolName: string,
  before?: string | null,
): Promise<{ content: string; createdAt: string } | null> {
  const supabase = await createClient();
  let query = supabase
    .from("ai_conversation_messages")
    .select("content, created_at")
    .eq("customer_session_id", customerSessionId)
    .eq("role", "tool")
    .eq("tool_name", toolName)
    .eq("tool_success", true);
  if (before) query = query.lt("created_at", before);
  const { data } = await query
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? { content: data.content, createdAt: data.created_at } : null;
}

export async function insertMessage(
  restaurantId: string,
  customerSessionId: string,
  role: "user" | "assistant" | "tool",
  content: string,
  toolInfo?: { name: string; success: boolean },
): Promise<void> {
  const supabase = await createClient();
  await supabase.from("ai_conversation_messages").insert({
    restaurant_id: restaurantId,
    customer_session_id: customerSessionId,
    role,
    // A DB CHECK caps content at 8000 chars (defense in depth) — truncate
    // defensively here too so a pathological tool result never fails the
    // insert outright and silently drops an audit row.
    content: content.slice(0, 8000),
    tool_name: toolInfo?.name ?? null,
    tool_success: toolInfo?.success ?? null,
  });
}
