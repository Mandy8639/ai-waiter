"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  deletionErrorMessage,
  isDeletionConfirmed,
  type DeleteAccountState,
} from "./delete-core";

type Rpc = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

/**
 * Deletes the signed-in person's own account (the Account page's form).
 * Everything that decides whether it may happen is in delete_my_account():
 * this checks the typed confirmation, calls it, and signs the browser out.
 */
export async function deleteMyAccount(
  _previous: DeleteAccountState,
  formData: FormData,
): Promise<DeleteAccountState> {
  if (!isDeletionConfirmed(formData.get("confirmation"))) {
    return { error: "Type DELETE to confirm." };
  }

  const supabase = await createClient();
  const { error } = await (supabase.rpc.bind(supabase) as unknown as Rpc)(
    "delete_my_account",
  );
  if (error) return { error: deletionErrorMessage(error.message) };

  // The account is gone, so the session's tokens no longer work; this
  // clears the cookies that hold them.
  await supabase.auth.signOut();
  redirect("/login?deleted=1");
}
