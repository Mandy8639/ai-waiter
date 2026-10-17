"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { TwoFactorCodeField } from "@/components/auth/two-factor-code-field";
import {
  verifyTwoFactorSignIn,
  type TwoFactorFormState,
} from "@/lib/auth/two-factor-actions";

const initialState: TwoFactorFormState = {};

/** The code step after a password sign-in. */
export function TwoFactorVerifyForm({ inviteToken }: { inviteToken?: string }) {
  const [state, formAction, isPending] = useActionState(
    verifyTwoFactorSignIn,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {inviteToken && (
        <input type="hidden" name="inviteToken" value={inviteToken} />
      )}
      <TwoFactorCodeField error={state.error} disabled={isPending} autoFocus />
      <Button type="submit" disabled={isPending}>
        {isPending ? "Checking…" : "Verify"}
      </Button>
    </form>
  );
}
