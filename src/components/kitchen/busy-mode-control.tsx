"use client";

import { useEffect, useState, useTransition } from "react";
import { Hourglass, PauseCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  BUSY_CHOICES,
  BUSY_FOR_MINUTES,
  PAUSE_CHOICES,
  kitchenStatusFrom,
  minutesLeft,
  pauseChoiceLabel,
  type KitchenStatusRow,
} from "@/lib/kitchen/busy-core";
import {
  pauseNewOrders,
  resumeNewOrders,
  setRunningBehind,
} from "@/lib/kitchen/busy-actions";

/**
 * Busy mode on the kitchen board: a "Busy?" button with the two things a
 * swamped kitchen needs — stop new orders for a while, or warn diners
 * that food is taking longer — and, while either is on, a banner saying
 * so with a one-tap way back. Re-read against the clock every 30 seconds,
 * so a pause that runs out clears itself on screen too.
 */
export function BusyModeControl({
  restaurantId,
  initial,
  canChange,
}: {
  restaurantId: string;
  initial: KitchenStatusRow | null;
  /** Owner, manager or kitchen. Floor staff see the banners, not the switches. */
  canChange: boolean;
}) {
  const [row, setRow] = useState(initial);
  const [now, setNow] = useState(() => new Date());
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // The server sends fresh values after each change (revalidatePath).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRow(initial);
  }, [initial]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const status = kitchenStatusFrom(row, now);
  const left = minutesLeft(status, now);

  function act(
    run: () => Promise<{ error?: string }>,
    /** What the screen shows until the server answers, from the tap's time. */
    optimistic: (at: Date) => KitchenStatusRow,
  ) {
    setError(null);
    const before = row;
    const at = new Date();
    setRow(optimistic(at));
    setNow(at);
    startTransition(async () => {
      const result = await run();
      if (result.error) {
        setError(result.error);
        setRow(before);
      } else {
        setOpen(false);
      }
    });
  }

  const extra = status.extraMinutes;
  const pause = (minutes: number | null) =>
    act(
      () => pauseNewOrders(restaurantId, minutes),
      (at) => ({
        orders_paused_until:
          minutes === null
            ? "infinity"
            : new Date(at.getTime() + minutes * 60_000).toISOString(),
        busy_extra_minutes: extra,
      }),
    );
  const resume = () =>
    act(
      () => resumeNewOrders(restaurantId),
      () => ({ orders_paused_until: null, busy_extra_minutes: extra }),
    );
  const behind = (minutes: number) =>
    act(
      () => setRunningBehind(restaurantId, minutes),
      () => ({
        orders_paused_until: row?.orders_paused_until ?? null,
        busy_extra_minutes: minutes,
      }),
    );

  return (
    <div className="flex flex-col gap-2">
      {status.paused && (
        <div
          role="status"
          className="border-destructive bg-destructive/10 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3"
        >
          <span className="flex items-center gap-2 font-semibold">
            <PauseCircle
              className="text-destructive size-5"
              aria-hidden="true"
            />
            {left === null
              ? "New orders are paused until you resume."
              : `New orders are paused for ${left} more ${left === 1 ? "minute" : "minutes"}.`}
          </span>
          {canChange && (
            <Button
              type="button"
              className="min-h-11 px-5"
              onClick={resume}
              disabled={pending}
            >
              Resume orders now
            </Button>
          )}
        </div>
      )}
      {extra > 0 && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/50 bg-amber-500/10 px-4 py-3"
        >
          <span className="flex items-center gap-2 font-medium">
            <Hourglass
              className="size-5 text-amber-600 dark:text-amber-400"
              aria-hidden="true"
            />
            Diners are told food is taking about {extra} minutes longer.
          </span>
          {canChange && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 px-5"
              onClick={() => behind(0)}
              disabled={pending}
            >
              Back on time
            </Button>
          )}
        </div>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {canChange && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger
            render={
              <Button
                type="button"
                variant="outline"
                className="min-h-11 self-start px-5 font-semibold"
              >
                <Hourglass className="size-4" aria-hidden="true" />
                Busy?
              </Button>
            }
          />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Kitchen busy?</DialogTitle>
              <DialogDescription>
                Diners see this on the menu straight away. Orders already placed
                aren&apos;t affected.
              </DialogDescription>
            </DialogHeader>

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">Pause new orders</h3>
              <p className="text-muted-foreground text-sm">
                Diners can still browse, but can&apos;t order until it&apos;s
                over. It turns back on by itself.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {PAUSE_CHOICES.map((minutes) => (
                  <Button
                    key={minutes ?? "until"}
                    type="button"
                    variant="outline"
                    className="min-h-12"
                    disabled={pending}
                    onClick={() => pause(minutes)}
                  >
                    {pauseChoiceLabel(minutes)}
                  </Button>
                ))}
              </div>
              {status.paused && (
                <Button
                  type="button"
                  className="min-h-12"
                  disabled={pending}
                  onClick={resume}
                >
                  Resume orders now
                </Button>
              )}
            </section>

            <section className="flex flex-col gap-2 border-t pt-4">
              <h3 className="text-sm font-semibold">Running behind</h3>
              <p className="text-muted-foreground text-sm">
                Keep taking orders, and tell diners food is taking longer.
                Clears itself after{" "}
                {BUSY_FOR_MINUTES / 60 === 1
                  ? "an hour"
                  : `${BUSY_FOR_MINUTES} minutes`}
                .
              </p>
              <div className="grid grid-cols-3 gap-2">
                {BUSY_CHOICES.map((minutes) => (
                  <Button
                    key={minutes}
                    type="button"
                    variant={extra === minutes ? "default" : "outline"}
                    aria-pressed={extra === minutes}
                    className="min-h-12"
                    disabled={pending}
                    onClick={() => behind(minutes)}
                  >
                    +{minutes} min
                  </Button>
                ))}
              </div>
              {extra > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11"
                  disabled={pending}
                  onClick={() => behind(0)}
                >
                  Back on time
                </Button>
              )}
            </section>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
