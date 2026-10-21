"use client";

import { useState, useTransition } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { setPlanCancellation } from "@/lib/billing/subscription-actions";
import type { CancelControls } from "@/lib/billing/subscription-cancel-core";

/**
 * Cancel the restaurant's Tableside plan, or undo a cancellation, from the
 * Payments page. Cancelling takes effect at the end of the month already
 * paid for; nothing stops before then.
 */
export function PlanCancelControls({
  restaurantId,
  controls,
  timeZone,
}: {
  restaurantId: string;
  controls: CancelControls;
  timeZone: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (controls.kind === "none") return null;

  const date = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
          timeZone,
        })
      : null;

  function change(cancel: boolean) {
    setError(null);
    start(async () => {
      const r = await setPlanCancellation(restaurantId, cancel);
      setConfirming(false);
      if (!r.ok) setError(r.error ?? "That didn't work. Please try again.");
    });
  }

  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      {controls.kind === "ending" ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium">
            Your plan ends
            {date(controls.endsOn) ? ` on ${date(controls.endsOn)}` : " soon"}.
          </p>
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() => change(false)}
          >
            {pending ? "Keeping…" : "Keep my plan"}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted-foreground text-xs">
            You can cancel any time; your plan stays active until the end of the
            month you&apos;ve paid for.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => setConfirming(true)}
          >
            Cancel plan
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel your plan?</AlertDialogTitle>
            <AlertDialogDescription>
              Everything keeps working until{" "}
              {controls.kind === "can_cancel" && date(controls.activeUntil)
                ? date(controls.activeUntil)
                : "the end of the month you've paid for"}
              , and you won&apos;t be charged again. A week after that, new QR
              orders pause: your menu stays up and you keep every dashboard
              tool, so you can pick a plan again any time. You can undo this
              before then.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my plan</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => change(true)}
            >
              {pending ? "Cancelling…" : "Yes, cancel"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
