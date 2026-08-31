"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { PaymentActionState } from "@/lib/payments/actions";

const initialState: PaymentActionState = {};

type Action = (
  prevState: PaymentActionState,
  formData: FormData,
) => Promise<PaymentActionState>;

export interface ConnectAccountStatus {
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

/**
 * Deliberately reports the capability flags separately rather than
 * collapsing them to "connected". An account can exist, have its details
 * submitted, and still not be able to take a charge — showing one green
 * tick would hide exactly the state a restaurant needs to act on.
 */
export function ConnectAccountPanel({
  status,
  onboardAction,
  refreshAction,
}: {
  status: ConnectAccountStatus;
  onboardAction: Action;
  refreshAction: Action;
}) {
  const [onboardState, onboard, onboarding] = useActionState(
    onboardAction,
    initialState,
  );
  const [refreshState, refresh, refreshing] = useActionState(
    refreshAction,
    initialState,
  );

  const error = onboardState.error ?? refreshState.error;

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={status.chargesEnabled ? "secondary" : "outline"}>
          {status.chargesEnabled
            ? "Can take payments"
            : "Cannot take payments yet"}
        </Badge>
        {status.connected && (
          <>
            <Badge variant={status.detailsSubmitted ? "secondary" : "outline"}>
              {status.detailsSubmitted
                ? "Details submitted"
                : "Details incomplete"}
            </Badge>
            {/*
              No payouts badge. Phase 1 applies only the `merchant`
              configuration to the connected account, so Stripe never
              reports a payouts capability and the badge would read
              "pending" forever regardless of what the restaurant did — a
              permanent false alarm is worse than no badge. The restaurant
              manages payouts in their own Stripe dashboard. The field is
              still synced and stored, ready for a later phase that
              requests the recipient configuration.
            */}
          </>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <form action={onboard}>
          <Button type="submit" disabled={onboarding}>
            {onboarding
              ? "Opening Stripe…"
              : status.connected
                ? "Continue on Stripe"
                : "Connect with Stripe"}
          </Button>
        </form>

        {status.connected && (
          <form action={refresh}>
            <Button type="submit" variant="outline" disabled={refreshing}>
              {refreshing ? "Checking…" : "Refresh status"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
