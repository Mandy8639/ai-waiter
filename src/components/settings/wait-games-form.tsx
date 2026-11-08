"use client";

import { useActionState, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { WaitGamesFormState } from "@/lib/wait-games/actions";

const initialState: WaitGamesFormState = {};

/** The while-you-wait games switch. Controlled, so a failed save keeps the choice. */
export function WaitGamesForm({
  action,
  enabled,
  disabled,
}: {
  action: (
    prev: WaitGamesFormState,
    formData: FormData,
  ) => Promise<WaitGamesFormState>;
  enabled: boolean;
  disabled: boolean;
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);
  const [on, setOn] = useState(enabled);

  return (
    <form action={formAction} className="flex flex-col gap-3" noValidate>
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
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="enabled"
          checked={on}
          onChange={(e) => setOn(e.target.checked)}
          disabled={disabled || isPending}
          className="mt-0.5 size-4"
        />
        <span>
          Show while-you-wait games on guests&apos; order pages
          <span className="text-muted-foreground block">
            A three-question quiz about your menu and a match game with your
            dish photos, from ordering until the food is served. No prizes,
            nothing for you to set up.
          </span>
        </span>
      </label>
      {!disabled && (
        <div>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </form>
  );
}
