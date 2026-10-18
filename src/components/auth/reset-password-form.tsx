"use client";

import { useActionState, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  NewPasswordFields,
  newPasswordsDiffer,
} from "@/components/auth/new-password-fields";
import {
  setNewPassword,
  type PasswordFormState,
} from "@/lib/auth/password-actions";

const initialState: PasswordFormState = {};

/** Choosing a new password after a reset link (/reset-password). */
export function ResetPasswordForm() {
  const [state, formAction, isPending] = useActionState(
    setNewPassword,
    initialState,
  );
  const [mismatch, setMismatch] = useState(false);

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (newPasswordsDiffer(event.currentTarget)) {
          event.preventDefault();
          setMismatch(true);
        }
      }}
      className="flex flex-col gap-5"
      noValidate
    >
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <NewPasswordFields
        disabled={isPending}
        mismatch={mismatch}
        onEdit={() => setMismatch(false)}
        errors={state.fieldErrors}
      />
      <Button type="submit" disabled={isPending} className="mt-2">
        {isPending ? "Saving…" : "Save new password"}
      </Button>
    </form>
  );
}
