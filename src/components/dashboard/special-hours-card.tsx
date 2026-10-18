"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deleteSpecialHours, saveSpecialHours } from "@/lib/menus/actions";
import {
  SPECIAL_HOURS_NOTE_MAX,
  checkSpecialHours,
  specialDayLabel,
  specialHoursLabel,
  type SpecialHours,
} from "@/lib/menus/core";
import { cn } from "@/lib/utils";

/**
 * Holidays and one-off hours: a date the restaurant is closed, or open only
 * between two times. For that date it overrides every menu's hours, so
 * diners can't order outside it (menu_on_now(), 20261019090000).
 */
export function SpecialHoursCard({
  restaurantId,
  upcoming,
  today,
}: {
  restaurantId: string;
  upcoming: SpecialHours[];
  /** "2026-12-25" in the restaurant's timezone. */
  today: string;
}) {
  const [day, setDay] = useState("");
  const [closed, setClosed] = useState(true);
  const [opens, setOpens] = useState("17:00");
  const [closes, setCloses] = useState("21:00");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const input = { day, closed, opens, closes, note };
  const check = checkSpecialHours(input, today);
  const replaces = upcoming.find((u) => u.day === day);

  function run(action: () => Promise<{ error?: string }>, after?: () => void) {
    setError(null);
    start(async () => {
      const result = await action();
      if (result.error) setError(result.error);
      else after?.();
    });
  }

  return (
    <section
      aria-labelledby="special-hours"
      className="flex flex-col gap-4 rounded-lg border p-4"
    >
      <div>
        <h2 id="special-hours" className="font-medium">
          Holidays and special hours
        </h2>
        <p className="text-muted-foreground text-sm">
          Closed for a holiday, or open shorter hours one day? Add the date. On
          that day it replaces every menu&apos;s hours, and diners see why.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {upcoming.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing coming up: your usual hours apply.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {upcoming.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
            >
              <span className="min-w-0">
                <span className="font-medium">
                  {entry.day === today ? "Today" : specialDayLabel(entry.day)}
                </span>
                <span
                  className={cn(
                    "ml-2",
                    entry.closed ? "text-destructive" : "text-foreground",
                  )}
                >
                  {specialHoursLabel(entry)}
                </span>
                {entry.note && (
                  <span className="text-muted-foreground block truncate text-xs">
                    {entry.note}
                  </span>
                )}
              </span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Remove ${specialDayLabel(entry.day)}`}
                disabled={pending}
                onClick={() =>
                  run(() => deleteSpecialHours(restaurantId, entry.id))
                }
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(
            () => saveSpecialHours(restaurantId, input),
            () => {
              setDay("");
              setNote("");
            },
          );
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="date"
            value={day}
            min={today}
            onChange={(e) => setDay(e.target.value)}
            aria-label="Date"
            className="w-44"
          />
          <div
            className="flex overflow-hidden rounded-md border"
            role="group"
            aria-label="Closed or special hours"
          >
            {[
              { value: true, label: "Closed" },
              { value: false, label: "Special hours" },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                aria-pressed={closed === o.value}
                onClick={() => setClosed(o.value)}
                className={cn(
                  "px-3 py-1.5 text-sm",
                  closed === o.value
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
          {!closed && (
            <>
              <Input
                type="time"
                value={opens}
                onChange={(e) => setOpens(e.target.value)}
                aria-label="Opens"
                className="w-28"
              />
              <span className="text-muted-foreground text-sm">to</span>
              <Input
                type="time"
                value={closes === "24:00" ? "23:59" : closes}
                onChange={(e) =>
                  setCloses(
                    e.target.value === "23:59" ? "24:00" : e.target.value,
                  )
                }
                aria-label="Closes"
                className="w-28"
              />
            </>
          )}
        </div>
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={SPECIAL_HOURS_NOTE_MAX}
          placeholder="Note for diners, e.g. Thanksgiving (optional)"
          aria-label="Note for diners"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" disabled={pending || !check.ok}>
            {replaces ? "Replace this date" : "Add date"}
          </Button>
          {day && !check.ok && (
            <span className="text-muted-foreground text-sm">{check.error}</span>
          )}
        </div>
      </form>
    </section>
  );
}
