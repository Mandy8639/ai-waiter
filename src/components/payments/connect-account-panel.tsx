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
 * Deliberately reports Stripe's three capability flags separately rather
 * than collapsing them to "connected". An account can exist, have its
 * details submitted, and still not be able to take a charge — showing one
 * green tick would hide exactly the state a restaurant needs to act on.
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
            <Badge variant={status.payoutsEnabled ? "secondary" : "outline"}>
              {status.payoutsEnabled ? "Payouts enabled" : "Payouts pending"}
            </Badge>
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
