"use client";

import { useMemo, useState, useTransition } from "react";
import { Search } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  filterSoldOutMenu,
  formatBackAt,
  soldOutNow,
  type SoldOutCategory,
} from "@/lib/menu/sold-out-core";
import {
  setDishAvailability,
  setDishSoldOutUntilTomorrow,
  setOptionAvailability,
} from "@/lib/menu/sold-out-actions";

type Kind = "dish" | "option";
const key = (kind: Kind, id: string) => `${kind}:${id}`;

/**
 * Big, one-tap switches for a tablet on the pass. Each tap shows its new
 * state at once and is put back if the server refuses it, so a cook never
 * waits on a spinner to know what they did.
 *
 * A sold-out dish also offers "Until tomorrow": it then comes back by
 * itself at the restaurant's next opening, so nobody has to remember.
 */
export function SoldOutBoard({
  restaurantId,
  menu,
  timeZone,
}: {
  restaurantId: string;
  menu: SoldOutCategory[];
  /** The restaurant's, for "Back tomorrow 11:00 AM". */
  timeZone: string;
}) {
  // Taps not yet confirmed by the server, layered over the page's data.
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  // Dishes' "back at" times changed since the page loaded (null: no timer).
  const [backAts, setBackAts] = useState<Map<string, string | null>>(new Map());
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const current = useMemo(
    () =>
      menu.map((category) => ({
        ...category,
        dishes: category.dishes.map((dish) => ({
          ...dish,
          available: overrides.get(key("dish", dish.id)) ?? dish.available,
          backAt: backAts.has(dish.id)
            ? (backAts.get(dish.id) ?? null)
            : dish.backAt,
          options: dish.options.map((option) => ({
            ...option,
            available:
              overrides.get(key("option", option.id)) ?? option.available,
          })),
        })),
      })),
    [menu, overrides, backAts],
  );
  const visible = useMemo(
    () => filterSoldOutMenu(current, query),
    [current, query],
  );
  const offNow = useMemo(() => soldOutNow(current), [current]);

  function toggle(kind: Kind, id: string, available: boolean) {
    const k = key(kind, id);
    setError(null);
    setOverrides((prev) => new Map(prev).set(k, available));
    if (kind === "dish") setBackAts((prev) => new Map(prev).set(id, null));
    startTransition(async () => {
      const result =
        kind === "dish"
          ? await setDishAvailability(restaurantId, id, available)
          : await setOptionAvailability(restaurantId, id, available);
      if (result.error) {
        setError(result.error);
        setOverrides((prev) => new Map(prev).set(k, !available));
      }
    });
  }

  function untilTomorrow(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await setDishSoldOutUntilTomorrow(restaurantId, id);
      if (result.error || !result.backAt) {
        setError(result.error ?? "Couldn't change that dish.");
        return;
      }
      const backAt = result.backAt;
      setOverrides((prev) => new Map(prev).set(key("dish", id), false));
      setBackAts((prev) => new Map(prev).set(id, backAt));
    });
  }

  if (menu.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        There&apos;s nothing on the menu yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <section aria-labelledby="off-now" className="flex flex-col gap-2">
        <h2 id="off-now" className="text-base font-semibold">
          Sold out now
        </h2>
        {offNow.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Everything is available.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {offNow.map((entry) => (
              <li key={key(entry.kind, entry.id)}>
                <button
                  type="button"
                  onClick={() => toggle(entry.kind, entry.id, true)}
                  className="border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15 flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium"
                >
                  {entry.label}
                  <span className="text-foreground/70 text-xs">
                    {entry.kind === "dish" && entry.backAt
                      ? formatBackAt(entry.backAt, timeZone)
                      : "Tap when back"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="relative">
        <Search
          aria-hidden="true"
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a dish or add-on"
          aria-label="Find a dish or add-on"
          className="h-11 pl-9 text-base"
        />
      </div>

      {visible.length === 0 && (
        <p className="text-muted-foreground text-sm">
          Nothing matches &ldquo;{query}&rdquo;.
        </p>
      )}

      {visible.map((category) => (
        <section key={category.id} className="flex flex-col gap-2">
          <h2 className="text-muted-foreground text-sm font-semibold tracking-wide uppercase">
            {category.name}
          </h2>
          <ul className="flex flex-col gap-2">
            {category.dishes.map((dish) => (
              <li key={dish.id} className="rounded-xl border p-3">
                <AvailabilityRow
                  label={dish.name}
                  available={dish.available}
                  onToggle={() => toggle("dish", dish.id, !dish.available)}
                  emphasis
                />
                {!dish.available && (
                  <div className="mt-2 flex items-center justify-end gap-2 text-sm">
                    {dish.backAt ? (
                      <span className="text-muted-foreground">
                        {formatBackAt(dish.backAt, timeZone)}, by itself
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => untilTomorrow(dish.id)}
                        className="hover:bg-muted min-h-11 rounded-full border px-4 font-medium"
                      >
                        Until tomorrow
                      </button>
                    )}
                  </div>
                )}
                {dish.options.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-1.5 border-t pt-2">
                    {dish.options.map((option) => (
                      <li key={option.id}>
                        <AvailabilityRow
                          label={option.name}
                          detail={option.groupName}
                          available={option.available}
                          onToggle={() =>
                            toggle("option", option.id, !option.available)
                          }
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function AvailabilityRow({
  label,
  detail,
  available,
  onToggle,
  emphasis = false,
}: {
  label: string;
  detail?: string;
  available: boolean;
  onToggle: () => void;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0">
        <span
          className={cn(
            "block truncate",
            emphasis ? "font-medium" : "text-sm",
            !available && "text-muted-foreground line-through",
          )}
        >
          {label}
        </span>
        {detail && (
          <span className="text-muted-foreground block text-xs">{detail}</span>
        )}
      </span>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={!available}
        aria-label={`${label}: ${available ? "available, tap to mark sold out" : "sold out, tap to bring back"}`}
        className={cn(
          "min-h-11 w-32 shrink-0 rounded-full border text-sm font-semibold transition-colors",
          available
            ? "border-emerald-600/40 bg-emerald-600/10 text-emerald-700 hover:bg-emerald-600/15 dark:text-emerald-400"
            : "border-destructive bg-destructive text-white hover:opacity-90",
        )}
      >
        {available ? "Available" : "Sold out"}
      </button>
    </div>
  );
}
