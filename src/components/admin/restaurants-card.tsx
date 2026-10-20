"use client";

import { useMemo, useState, useTransition } from "react";
import { Search } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { setRestaurantAiFeature } from "@/lib/admin/restaurant-switch-actions";
import {
  FEATURE_LABELS,
  RESTAURANT_AI_FEATURES,
  SWITCH_REASON_MAX,
  type RestaurantAiFeature,
} from "@/lib/admin/restaurant-switches-core";
import type {
  AdminRestaurantRow,
  SwitchHistoryRow,
} from "@/lib/admin/restaurant-switch-queries";
import { cn } from "@/lib/utils";

/**
 * Admin Phase 6 (docs/admin.md): every restaurant, with switches for its
 * AI waiter, staff assistant and AI menu tools. Off overrides the
 * restaurant's own settings, takes effect within a minute, and the
 * restaurant is told "Switched off by Tableside" with the support address.
 * Turning one off asks for a short reason, kept for the admin only.
 */
export function RestaurantsCard({
  restaurants,
  history,
}: {
  restaurants: AdminRestaurantRow[] | null;
  history: SwitchHistoryRow[];
}) {
  const [query, setQuery] = useState("");
  const [onlyOff, setOnlyOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Switch-offs waiting for a reason: "restaurantId:feature".
  const [asking, setAsking] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (restaurants ?? []).filter(
      (r) =>
        (!q ||
          r.name.toLowerCase().includes(q) ||
          r.slug.toLowerCase().includes(q)) &&
        (!onlyOff || Object.keys(r.off).length > 0),
    );
  }, [restaurants, query, onlyOff]);

  const offCount = (restaurants ?? []).filter(
    (r) => Object.keys(r.off).length > 0,
  ).length;

  function change(
    restaurantId: string,
    feature: RestaurantAiFeature,
    enabled: boolean,
    note: string,
  ) {
    setError(null);
    start(async () => {
      const result = await setRestaurantAiFeature(
        restaurantId,
        feature,
        enabled,
        note,
      );
      if (!result.ok) setError(result.error);
      setAsking(null);
      setReason("");
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Restaurants</CardTitle>
        <CardDescription>
          Switch an AI feature off for one restaurant. It overrides the
          restaurant&apos;s own settings and takes effect within a minute; the
          restaurant sees &ldquo;Switched off by Tableside&rdquo; with the
          support address. Everyone else is unaffected.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {restaurants === null ? (
          <p className="text-destructive text-sm">
            Couldn&apos;t load the restaurants just now. Reload in a minute.
          </p>
        ) : (
          <>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-48 flex-1">
                <Search
                  aria-hidden="true"
                  className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
                />
                <Input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Find a restaurant"
                  aria-label="Find a restaurant"
                  className="pl-9"
                />
              </div>
              <Button
                type="button"
                size="sm"
                variant={onlyOff ? "default" : "outline"}
                aria-pressed={onlyOff}
                onClick={() => setOnlyOff((v) => !v)}
              >
                Switched off ({offCount})
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              {shown.length} of {restaurants.length} restaurants
            </p>

            <ul className="flex flex-col gap-2">
              {shown.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-col gap-2 rounded-lg border p-3"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="min-w-0">
                      <span className="font-medium">{r.name}</span>{" "}
                      <span className="text-muted-foreground text-xs break-all">
                        /r/{r.slug}
                      </span>
                    </span>
                    {!r.isActive && <Badge variant="outline">Inactive</Badge>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {RESTAURANT_AI_FEATURES.map((feature) => {
                      const off = r.off[feature];
                      const key = `${r.id}:${feature}`;
                      return (
                        <button
                          key={feature}
                          type="button"
                          disabled={pending}
                          title={
                            off?.reason
                              ? `Switched off: ${off.reason}`
                              : FEATURE_LABELS[feature].covers
                          }
                          aria-pressed={!off}
                          aria-label={`${FEATURE_LABELS[feature].label} for ${r.name}: ${off ? "off, press to turn on" : "on, press to switch off"}`}
                          onClick={() => {
                            if (off) change(r.id, feature, true, "");
                            else {
                              setAsking(key);
                              setReason("");
                            }
                          }}
                          className={cn(
                            "min-h-9 rounded-full border px-3 text-xs font-medium transition-colors disabled:opacity-50",
                            off
                              ? "border-destructive bg-destructive/10 text-destructive"
                              : "border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400",
                          )}
                        >
                          {FEATURE_LABELS[feature].label}: {off ? "Off" : "On"}
                        </button>
                      );
                    })}
                  </div>
                  {RESTAURANT_AI_FEATURES.map((feature) =>
                    r.off[feature]?.reason ? (
                      <p
                        key={feature}
                        className="text-muted-foreground text-xs"
                      >
                        {FEATURE_LABELS[feature].label} off:{" "}
                        {r.off[feature]!.reason}
                      </p>
                    ) : null,
                  )}
                  {RESTAURANT_AI_FEATURES.map((feature) =>
                    asking === `${r.id}:${feature}` ? (
                      <form
                        key={feature}
                        className="flex flex-wrap items-center gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          change(r.id, feature, false, reason);
                        }}
                      >
                        <Input
                          autoFocus
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          maxLength={SWITCH_REASON_MAX}
                          placeholder={`Why switch off ${FEATURE_LABELS[feature].label.toLowerCase()}? (for you only)`}
                          aria-label="Reason, for your own records"
                          className="min-w-56 flex-1"
                        />
                        <Button
                          type="submit"
                          size="sm"
                          variant="destructive"
                          disabled={pending}
                        >
                          Switch off
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setAsking(null)}
                        >
                          Cancel
                        </Button>
                      </form>
                    ) : null,
                  )}
                </li>
              ))}
            </ul>

            {history.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer font-medium">
                  Recent switch changes
                </summary>
                <ul className="text-muted-foreground mt-2 flex flex-col gap-1 text-xs">
                  {history.map((h, i) => (
                    <li key={i}>
                      {new Date(h.changedAt).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}{" "}
                      · {h.restaurantName} · {FEATURE_LABELS[h.feature].label}{" "}
                      {h.action === "off" ? "switched off" : "turned back on"}
                      {h.reason ? ` · ${h.reason}` : ""}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
