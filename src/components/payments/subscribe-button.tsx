"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface SubscribeState {
  error?: string;
}

const initialState: SubscribeState = {};

/**
 * One plan's subscribe control.
 *
 * A form rather than a link because the action redirects to Stripe, and a
 * plain anchor would need the checkout URL to exist before anyone clicked
 * — which would mean creating a Stripe session for every plan on every
 * page load.
 */
export function SubscribeButton({
  action,
  label,
  disabled,
}: {
  action: (
    state: SubscribeState,
    formData: FormData,
  ) => Promise<SubscribeState>;
  label: string;
  disabled?: boolean;
}) {
  const [state, submit, pending] = useActionState(action, initialState);

  return (
    <form action={submit} className="flex flex-col gap-1">
      <Button type="submit" size="sm" disabled={pending || disabled}>
        {pending ? "Opening…" : label}
      </Button>
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}
