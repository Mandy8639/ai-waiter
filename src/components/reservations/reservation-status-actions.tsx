"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { TransitionReservationResult } from "@/lib/reservations/actions";

/** confirmed -> seated -> completed, plus cancelled/no_show from confirmed only — mirrors is_valid_reservation_status_transition() exactly (the DB re-checks this regardless; these are just which buttons make sense to show). */
const NEXT_ACTIONS: Record<string, { status: string; label: string }[]> = {
  confirmed: [
    { status: "seated", label: "Seat" },
    { status: "no_show", label: "No-show" },
    { status: "cancelled", label: "Cancel" },
  ],
  seated: [{ status: "completed", label: "Complete" }],
};

export function ReservationStatusActions({
  status,
  onTransition,
}: {
  status: string;
  onTransition: (targetStatus: string) => Promise<TransitionReservationResult>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const actions = NEXT_ACTIONS[status] ?? [];
  if (actions.length === 0) return null;

  function handleClick(targetStatus: string) {
    setError(null);
    startTransition(async () => {
      const result = await onTransition(targetStatus);
      if (result.error) setError(result.error);
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-2">
        {actions.map((action) => (
          <Button
            key={action.status}
            type="button"
            size="sm"
            variant={action.status === "cancelled" ? "destructive" : "outline"}
            disabled={isPending}
            onClick={() => handleClick(action.status)}
          >
            {action.label}
          </Button>
        ))}
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
