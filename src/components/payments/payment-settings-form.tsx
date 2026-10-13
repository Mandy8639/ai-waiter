"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/dashboard/native-select";
import { FormField } from "@/components/dashboard/form-field";
import type { PaymentActionState } from "@/lib/payments/actions";

const initialState: PaymentActionState = {};

export function PaymentSettingsForm({
  action,
  defaultValues,
  chargesEnabled,
}: {
  action: (
    prevState: PaymentActionState,
    formData: FormData,
  ) => Promise<PaymentActionState>;
  defaultValues: {
    paymentTiming: "at_order" | "at_end";
    acceptCard: boolean;
    acceptCash: boolean;
    acceptCardTerminal: boolean;
    tippingEnabled: boolean;
  };
  chargesEnabled: boolean;
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-5">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <FormField
        id="paymentTiming"
        label="When customers pay"
        hint="Paying at the end lets orders reach the kitchen immediately. Paying up front holds an order until it's paid — which only works once card payments are live."
      >
        <NativeSelect
          id="paymentTiming"
          name="paymentTiming"
          defaultValue={defaultValues.paymentTiming}
          disabled={isPending}
        >
          <option value="at_end">At the end of the meal</option>
          <option value="at_order">Up front, when they order</option>
        </NativeSelect>
      </FormField>

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          {/* Disabled when the connected account cannot charge — a disabled
              checkbox submits nothing, so card acceptance correctly falls
              back to off rather than claiming a capability Stripe denies.

              Keyed on the values that determine its default. These inputs
              are uncontrolled, so `defaultChecked` is read once at mount
              and ignored on every later render — when "Refresh status"
              flips chargesEnabled, or a save returns new settings, the box
              would otherwise keep showing the old state while React warns
              that a default changed after initialisation. The key remounts
              it so the default is applied afresh, which is what keeps the
              displayed state honest without making the whole form
              controlled. */}
          <Checkbox
            key={`acceptCard:${defaultValues.acceptCard}:${chargesEnabled}`}
            id="acceptCard"
            name="acceptCard"
            defaultChecked={defaultValues.acceptCard && chargesEnabled}
            disabled={isPending || !chargesEnabled}
          />
          <Label htmlFor="acceptCard">Accept card payments</Label>
        </div>
        {!chargesEnabled && (
          <p className="text-muted-foreground -mt-1 text-sm">
            Connect a Stripe account that can take payments before turning this
            on.
          </p>
        )}

        <div className="flex items-center gap-2">
          <Checkbox
            key={`acceptCash:${defaultValues.acceptCash}`}
            id="acceptCash"
            name="acceptCash"
            defaultChecked={defaultValues.acceptCash}
            disabled={isPending}
          />
          <Label htmlFor="acceptCash">Let staff record cash payments</Label>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            key={`acceptCardTerminal:${defaultValues.acceptCardTerminal}`}
            id="acceptCardTerminal"
            name="acceptCardTerminal"
            defaultChecked={defaultValues.acceptCardTerminal}
            disabled={isPending}
          />
          <Label htmlFor="acceptCardTerminal">
            Let staff record payments taken on your own card machine
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            key={`tippingEnabled:${defaultValues.tippingEnabled}`}
            id="tippingEnabled"
            name="tippingEnabled"
            defaultChecked={defaultValues.tippingEnabled}
            disabled={isPending}
          />
          <Label htmlFor="tippingEnabled">Offer a tip at checkout</Label>
        </div>
      </div>

      <Button type="submit" disabled={isPending} className="mt-1 self-start">
        {isPending ? "Saving…" : "Save payment settings"}
      </Button>
    </form>
  );
}
