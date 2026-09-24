"use client";

import { useState, useTransition } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * On success the action redirects, so this never has to render a "joined!"
 * state — the next thing the accepter sees is the dashboard of the
 * restaurant they just joined. It only handles the failures: a link that
 * expired, was cancelled, or was used in the seconds between the page
 * rendering and the button being pressed.
 */
export function AcceptInvitationButton({
  onAccept,
  label,
}: {
  onAccept: () => Promise<{ error?: string }>;
  label: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const result = await onAccept();
      if (result.error) setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button type="button" onClick={handleClick} disabled={isPending}>
        {isPending ? "Joining…" : label}
      </Button>
    </div>
  );
}
