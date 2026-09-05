import { Check } from "lucide-react";
import { orderProgress } from "@/lib/orders/progress";

/**
 * Where the order has got to, at a glance.
 *
 * A server component: OrderStatusSync already keeps this page live with
 * realtime plus a polling fallback and re-renders it on the server, so
 * there is no client state to hold here and no second subscription to
 * open for the same row.
 *
 * Each step carries its state in TEXT as well as position and colour —
 * a screen reader hears "Being cooked, in progress", not a list of five
 * identical-sounding lines (SC 1.4.1). The whole list is one polite live
 * region on the page already, via the status badge above it.
 */
export function OrderProgress({
  status,
  eta,
}: {
  status: string;
  eta: string | null;
}) {
  const steps = orderProgress(status);

  // Cancelled orders left this line rather than stalling on it. Drawing a
  // greyed-out tracker would read like the food is still coming.
  if (steps.length === 0) return null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <ol className="flex flex-col gap-3">
        {steps.map((step) => (
          <li key={step.label} className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className={
                step.state === "done"
                  ? "bg-primary text-primary-foreground flex size-6 shrink-0 items-center justify-center rounded-full"
                  : step.state === "current"
                    ? "border-primary bg-primary/10 flex size-6 shrink-0 items-center justify-center rounded-full border-2"
                    : "border-muted-foreground/30 flex size-6 shrink-0 items-center justify-center rounded-full border"
              }
            >
              {step.state === "done" && <Check className="size-3.5" />}
            </span>
            <span
              className={
                step.state === "upcoming"
                  ? "text-muted-foreground text-sm"
                  : "text-sm font-medium"
              }
            >
              {step.label}
              <span className="sr-only">
                {step.state === "done"
                  ? " — done"
                  : step.state === "current"
                    ? " — in progress"
                    : " — not started"}
              </span>
            </span>
          </li>
        ))}
      </ol>

      {/*
        Sits under the steps rather than beside the current one: it is
        about the whole order, and a diner reads the list top to bottom
        and then wants the number.
      */}
      {eta && (
        <p className="text-muted-foreground border-t pt-3 text-sm">{eta}</p>
      )}
    </div>
  );
}
