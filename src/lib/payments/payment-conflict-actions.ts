"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { parsePaymentError } from "./errors";

/**
 * "Got it" on Settle up's paid-twice notice (20261120090000).
 * acknowledge_payment_conflict() decides who may: an owner or manager.
 */
export async function acknowledgePaymentConflict(
  conflictId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(conflictId)) {
    return { ok: false, error: "That notice wasn't found." };
  }
  const supabase = (await createClient()) as unknown as SupabaseClient;
  const { error } = await supabase.rpc("acknowledge_payment_conflict", {
    p_conflict_id: conflictId,
  });
  if (error) return { ok: false, error: parsePaymentError(error.message) };
  revalidatePath("/dashboard/checkout");
  return { ok: true };
}
