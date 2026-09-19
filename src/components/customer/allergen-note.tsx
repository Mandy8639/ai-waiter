import { Info, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Allergens, stated the way the restaurant stated them.
 *
 * Only CONFIRMED allergens ever reach this component (every caller filters
 * `confirmed_at is not null`), so the text attributes them to the
 * restaurant rather than to this platform. Warning-toned, not red: a list
 * of allergens is information a diner needs, not an error, and the word
 * "Contains" carries the meaning without relying on colour (SC 1.4.1).
 */
export function AllergenLine({
  allergens,
  className,
}: {
  allergens: string[];
  className?: string;
}) {
  if (allergens.length === 0) return null;
  return (
    <p
      className={cn(
        "type-caption text-warning-foreground inline-flex items-start gap-1.5",
        className,
      )}
    >
      <TriangleAlert
        className="text-warning mt-0.5 size-3.5 shrink-0"
        aria-hidden="true"
      />
      <span>Contains {allergens.join(", ")}</span>
    </p>
  );
}

/** The fuller statement for the item page, including what to do about it. */
export function AllergenNote({ allergens }: { allergens: string[] }) {
  if (allergens.length === 0) {
    return (
      <div
        role="note"
        className="bg-muted/60 type-body-sm text-muted-foreground flex items-start gap-2.5 rounded-xl px-4 py-3"
      >
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p>
          The restaurant hasn&apos;t listed allergens for this dish. If you have
          an allergy, please ask a member of staff before ordering.
        </p>
      </div>
    );
  }

  return (
    <div
      role="note"
      className="border-warning/40 bg-warning/10 type-body-sm flex items-start gap-2.5 rounded-xl border px-4 py-3"
    >
      <TriangleAlert
        className="text-warning mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <p>
        <strong className="font-semibold">
          Contains {allergens.join(", ")}
        </strong>
        <span className="text-muted-foreground">
          {" "}
          — as listed by the restaurant. If you have an allergy, please check
          with staff before ordering.
        </span>
      </p>
    </div>
  );
}
