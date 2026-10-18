"use client";

import { useActionState, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/auth/password-input";
import {
  NewPasswordFields,
  newPasswordsDiffer,
} from "@/components/auth/new-password-fields";
import {
  changePassword,
  type PasswordFormState,
} from "@/lib/auth/password-actions";

const initialState: PasswordFormState = {};

/** "Change password" on /account: the current one, then the new one twice. */
export function ChangePasswordForm() {
  const [state, formAction, isPending] = useActionState(
    changePassword,
    initialState,
  );
  const [mismatch, setMismatch] = useState(false);
  const currentError = state.fieldErrors?.currentPassword?.[0];

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
      {state.message && (
        <Alert>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="currentPassword">Current password</Label>
        <PasswordInput
          id="currentPassword"
          name="currentPassword"
          fieldLabel="Current password"
          autoComplete="current-password"
          required
          disabled={isPending}
          aria-invalid={!!currentError}
          aria-describedby={currentError ? "current-password-error" : undefined}
        />
        {currentError && (
          <p id="current-password-error" className="text-destructive text-sm">
            {currentError}
          </p>
        )}
      </div>

      <NewPasswordFields
        disabled={isPending}
        mismatch={mismatch}
        onEdit={() => setMismatch(false)}
        errors={state.fieldErrors}
      />

      <div>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Changing…" : "Change password"}
        </Button>
      </div>
    </form>
  );
}
