"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/settings/operational-settings-form";
import type { SettingsFormState } from "@/lib/settings/actions";

const initialState: SettingsFormState = {};

export interface EmailPreferencesValues {
  dailySummary: boolean;
  paymentAlerts: boolean;
}

/**
 * The owner's own email choices (phase F). Per person, not per restaurant:
 * a co-owner turning off the daily summary doesn't turn it off for anyone
 * else.
 */
export function EmailPreferencesForm({
  action,
  defaultValues,
  email,
}: {
  action: (
    prevState: SettingsFormState,
    formData: FormData,
  ) => Promise<SettingsFormState>;
  defaultValues: EmailPreferencesValues;
  /** Where the emails go — the address they sign in with. */
  email: string | null;
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.success && (
        <Alert>
          <AlertDescription>Saved.</AlertDescription>
        </Alert>
      )}

      {email && (
        <p className="type-caption text-muted-foreground">
          Sent to {email}, the address you sign in with.
        </p>
      )}

      <Toggle
        id="emailDailySummary"
        label="Daily summary"
        description="Each morning: yesterday's orders, their value and your most-ordered dishes. Nothing is sent on a day with no orders."
        defaultChecked={defaultValues.dailySummary}
        disabled={isPending}
      />
      <Toggle
        id="emailPaymentAlerts"
        label="Payment alerts"
        description="Only when something needs you: your Tableside payment didn't go through, Stripe paused your card payments, or a diner's delayed payment failed."
        defaultChecked={defaultValues.paymentAlerts}
        disabled={isPending}
      />

      <Button type="submit" disabled={isPending} className="mt-2 self-start">
        {isPending ? "Saving…" : "Save email settings"}
      </Button>
    </form>
  );
}
