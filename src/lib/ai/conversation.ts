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
