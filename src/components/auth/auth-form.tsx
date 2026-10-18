"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/auth/password-input";
import type { AuthFormState } from "@/lib/auth/actions";
import { PASSWORD_MISMATCH_MESSAGE } from "@/lib/auth/auth-schemas";

interface AuthFormProps {
  action: (
    prevState: AuthFormState,
    formData: FormData,
  ) => Promise<AuthFormState>;
  submitLabel: string;
  pendingLabel: string;
  passwordAutoComplete: "current-password" | "new-password";
  passwordHint?: string;
  /** Sign-up: a second password field that must match the first. */
  confirmPassword?: boolean;
  /** Sign-in: where the "Forgot password?" link goes. */
  forgotPasswordHref?: string;
  /**
   * Set when the visitor arrived from a staff invitation link. Carried
   * through the form so signing in or up returns them to /join/<token>
   * instead of the dashboard or onboarding — see src/lib/auth/actions.ts.
   */
  inviteToken?: string;
}

const initialState: AuthFormState = {};

export function AuthForm({
  action,
  submitLabel,
  pendingLabel,
  passwordAutoComplete,
  passwordHint,
  confirmPassword = false,
  forgotPasswordHref,
  inviteToken,
}: AuthFormProps) {
  const [state, formAction, isPending] = useActionState(action, initialState);
  const [mismatch, setMismatch] = useState(false);
  const confirmError = mismatch
    ? PASSWORD_MISMATCH_MESSAGE
    : state.fieldErrors?.confirmPassword?.[0];

  // Caught here before submitting: a submitted form is cleared, so a
  // mismatch found only by the server would mean typing both again.
  const checkMatch = (event: React.FormEvent<HTMLFormElement>) => {
    if (!confirmPassword) return;
    const form = new FormData(event.currentTarget);
    const confirmValue = form.get("confirmPassword");
    if (confirmValue && form.get("password") !== confirmValue) {
      event.preventDefault();
      setMismatch(true);
    }
  };

  return (
    <form
      action={formAction}
      onSubmit={checkMatch}
      className="flex flex-col gap-5"
      noValidate
    >
      {inviteToken && (
        <input type="hidden" name="inviteToken" value={inviteToken} />
      )}
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
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          disabled={isPending}
          aria-invalid={!!state.fieldErrors?.email}
          aria-describedby={
            state.fieldErrors?.email ? "email-error" : undefined
          }
        />
        {state.fieldErrors?.email && (
          <p id="email-error" className="text-destructive text-sm">
            {state.fieldErrors.email[0]}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <Label htmlFor="password">Password</Label>
          {forgotPasswordHref && (
            <Link
              href={forgotPasswordHref}
              className="text-muted-foreground hover:text-foreground text-sm underline-offset-4 hover:underline"
            >
              Forgot password?
            </Link>
          )}
        </div>
        <PasswordInput
          id="password"
          name="password"
          fieldLabel="Password"
          autoComplete={passwordAutoComplete}
          required
          disabled={isPending}
          onChange={() => setMismatch(false)}
          aria-invalid={!!state.fieldErrors?.password}
          aria-describedby={
            state.fieldErrors?.password ? "password-error" : undefined
          }
        />
        {passwordHint && !state.fieldErrors?.password && (
          <p className="text-muted-foreground text-sm">{passwordHint}</p>
        )}
        {state.fieldErrors?.password && (
          <p id="password-error" className="text-destructive text-sm">
            {state.fieldErrors.password[0]}
          </p>
        )}
      </div>

      {confirmPassword && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="confirmPassword">Confirm password</Label>
          <PasswordInput
            id="confirmPassword"
            name="confirmPassword"
            fieldLabel="Confirm password"
            autoComplete="new-password"
            required
            disabled={isPending}
            onChange={() => setMismatch(false)}
            aria-invalid={!!confirmError}
            aria-describedby={
              confirmError ? "confirm-password-error" : undefined
            }
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
      )}

      <Button type="submit" disabled={isPending} className="mt-2">
        {isPending ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}
