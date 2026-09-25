import "server-only";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_AI_PERSONA, toAiPersona, type AiPersona } from "./persona";

/**
 * The persona for the restaurant the current diner is seated at.
 *
 * get_ai_persona() takes no argument — the restaurant comes from the
 * caller's own customer session inside the function — so there is nothing
 * here a client could point at another restaurant.
 *
 * Never throws and never fails the turn. A persona is cosmetic: if it
 * cannot be read, the waiter answers in the default voice rather than not
 * at all.
 *
 * database.types.ts predates 20260927090000, so the RPC is reached through
 * a named cast confined to this function — the same convention as
 * src/lib/table-requests/actions.ts.
 */
export async function getAiPersonaForSession(): Promise<AiPersona> {
  try {
    const supabase = await createClient();
    const rpc = supabase.rpc.bind(supabase) as unknown as (
      fn: string,
    ) => Promise<{ data: unknown; error: { message: string } | null }>;

    const { data, error } = await rpc("get_ai_persona");
    if (error) return DEFAULT_AI_PERSONA;

    return toAiPersona(Array.isArray(data) ? data[0] : data);
  } catch {
    return DEFAULT_AI_PERSONA;
  }
}
