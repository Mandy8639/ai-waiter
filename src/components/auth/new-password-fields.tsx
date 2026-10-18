"use client";

import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/auth/password-input";
import { PASSWORD_MISMATCH_MESSAGE } from "@/lib/auth/auth-schemas";

/**
 * "New password" twice, with eye buttons, for the reset and change forms.
 * The form checks the two match before submitting (see newPasswordsDiffer),
 * because a submitted form is cleared and a server-only check would mean
 * typing both again.
 */
export function NewPasswordFields({
  disabled,
  mismatch,
  onEdit,
  errors,
}: {
  disabled: boolean;
  mismatch: boolean;
  onEdit: () => void;
  errors?: { newPassword?: string[]; confirmPassword?: string[] };
}) {
  const newError = errors?.newPassword?.[0];
  const confirmError = mismatch
    ? PASSWORD_MISMATCH_MESSAGE
    : errors?.confirmPassword?.[0];

  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor="newPassword">New password</Label>
        <PasswordInput
          id="newPassword"
          name="newPassword"
          fieldLabel="New password"
          autoComplete="new-password"
          required
          disabled={disabled}
          onChange={onEdit}
          aria-invalid={!!newError}
          aria-describedby={newError ? "new-password-error" : undefined}
        />
        {newError ? (
          <p id="new-password-error" className="text-destructive text-sm">
            {newError}
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">
            At least 8 characters.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="confirmPassword">Confirm new password</Label>
        <PasswordInput
          id="confirmPassword"
          name="confirmPassword"
          fieldLabel="Confirm new password"
          autoComplete="new-password"
          required
          disabled={disabled}
          onChange={onEdit}
          aria-invalid={!!confirmError}
          aria-describedby={confirmError ? "confirm-password-error" : undefined}
        />
        {confirmError && (
          <p
            id="confirm-password-error"
            role="alert"
            className="text-destructive text-sm"
          >
            {confirmError}
          </p>
        )}
      </div>
    </>
  );
}

/** For a form's onSubmit: true when both are filled in and differ. */
export function newPasswordsDiffer(form: HTMLFormElement): boolean {
  const data = new FormData(form);
  const confirm = data.get("confirmPassword");
  return Boolean(confirm) && data.get("newPassword") !== confirm;
}
