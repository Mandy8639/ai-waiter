"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/dashboard/native-select";
import {
  assignDishStation,
  createStation,
  deleteStation,
  renameStation,
} from "@/lib/kitchen/station-actions";
import type { KitchenStation } from "@/lib/orders/kitchen";

export interface StationDish {
  id: string;
  name: string;
  categoryName: string | null;
  stationId: string | null;
}

/**
 * Setting up kitchen stations (phase I): name the stations, then send each
 * dish to one. Every change saves on its own, like the staff role picker.
 */
export function StationsManager({
  restaurantId,
  stations,
  dishes,
}: {
  restaurantId: string;
  stations: KitchenStation[];
  dishes: StationDish[];
}) {
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run(action: () => Promise<{ error?: string }>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.error) setError(result.error);
      else after?.();
    });
  }

  const unassigned = dishes.filter((d) => d.stationId === null).length;

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p
          role="alert"
          className="border-destructive/50 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm"
        >
          {error}
        </p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Stations</h2>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () => createStation(restaurantId, newName),
              () => setNewName(""),
            );
          }}
        >
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Grill, Fry, Cold, Bar"
            maxLength={40}
            aria-label="New station name"
          />
          <Button type="submit" disabled={isPending || !newName.trim()}>
            Add station
          </Button>
        </form>

        {stations.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No stations yet. Until you add one, the kitchen board works as one
            screen for everything.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {stations.map((station) => (
              <StationRow
                key={station.id}
                station={station}
                disabled={isPending}
                onRename={(name) =>
                  run(() => renameStation(restaurantId, station.id, name))
                }
                onDelete={() =>
                  run(() => deleteStation(restaurantId, station.id))
                }
              />
            ))}
          </ul>
        )}
      </section>

      {stations.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Which station makes each dish</h2>
          <p className="text-muted-foreground text-sm">
            A dish with no station shows on every station&apos;s screen. Changes
            apply to orders placed from now on.
            {unassigned > 0 &&
              ` ${unassigned} ${unassigned === 1 ? "dish has" : "dishes have"} no station.`}
          </p>
          {dishes.length === 0 ? (
            <p className="text-muted-foreground text-sm">No dishes yet.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {dishes.map((dish) => (
                <DishRow
                  key={dish.id}
                  dish={dish}
                  stations={stations}
                  onAssign={(stationId) =>
                    assignDishStation(restaurantId, dish.id, stationId)
                  }
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function StationRow({
  station,
  disabled,
  onRename,
  onDelete,
}: {
  station: KitchenStation;
  disabled: boolean;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(station.name);
  const [confirming, setConfirming] = useState(false);
  const changed = name.trim() !== station.name;

  return (
    <li className="flex flex-wrap items-center gap-2">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={40}
        aria-label={`Name of station ${station.name}`}
        className="max-w-60"
        disabled={disabled}
      />
      {changed && (
        <Button
          type="button"
          size="sm"
          disabled={disabled || !name.trim()}
          onClick={() => onRename(name)}
        >
          Save
        </Button>
      )}
      {confirming ? (
        <>
          <span className="text-muted-foreground text-sm">
            Delete {station.name}? Its dishes will show on every station.
          </span>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={disabled}
            onClick={onDelete}
          >
            Delete
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setConfirming(false)}
          >
            Keep
          </Button>
        </>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => setConfirming(true)}
        >
          Delete
        </Button>
      )}
    </li>
  );
}

function DishRow({
  dish,
  stations,
  onAssign,
}: {
  dish: StationDish;
  stations: KitchenStation[];
  onAssign: (stationId: string | null) => Promise<{ error?: string }>;
}) {
  const [value, setValue] = useState(dish.stationId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{dish.name}</p>
        {dish.categoryName && (
          <p className="text-muted-foreground text-xs">{dish.categoryName}</p>
        )}
        {error && <p className="text-destructive text-xs">{error}</p>}
      </div>
      <NativeSelect
        value={value}
        className="w-44"
        aria-label={`Station for ${dish.name}`}
        disabled={isPending}
        onChange={(e) => {
          const next = e.target.value;
          const previous = value;
          setValue(next);
          setError(null);
          startTransition(async () => {
            const result = await onAssign(next === "" ? null : next);
            if (result.error) {
              setError(result.error);
              setValue(previous);
            }
          });
        }}
      >
        <option value="">No station (every screen)</option>
        {stations.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </NativeSelect>
    </li>
  );
}
