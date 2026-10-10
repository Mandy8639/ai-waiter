import { PRIVACY_CONTACT_EMAIL } from "@/lib/legal/privacy";

/**
 * Account deletion's rules that don't need a server: what counts as
 * confirming, and what each refusal from delete_my_account() means in a
 * sentence. The rules themselves (whose account, the last owner, diners)
 * live in the database function and are tested in
 * tests/integration/db/delete-my-account.test.ts.
 */

/** What the person types to confirm. Case matters: it should be deliberate. */
export const DELETE_CONFIRMATION = "DELETE";

export function isDeletionConfirmed(input: unknown): boolean {
  return typeof input === "string" && input.trim() === DELETE_CONFIRMATION;
}

export interface DeleteAccountState {
  error?: string;
}

export function deletionErrorMessage(message: string): string {
  if (message.includes("SOLE_OWNER")) {
    return "You're the only owner of a restaurant. Make someone else an owner on its Staff page first.";
  }
  if (
    message.includes("NOT_SIGNED_IN") ||
    message.includes("ANONYMOUS_SESSION")
  ) {
    return "Sign in to delete your account.";
  }
  return `We couldn't delete your account. Please try again, or email ${PRIVACY_CONTACT_EMAIL}.`;
}
