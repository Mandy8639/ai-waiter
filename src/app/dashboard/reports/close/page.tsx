import Link from "next/link";
import { notFound } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DayCloseForm } from "@/components/reports/day-close-form";
import { DayCloseReport } from "@/components/reports/day-close-report";
import { PrintButton } from "@/components/printing/print-button";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/orders/format";
import { getPrintCapabilities } from "@/lib/printing/capabilities";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import {
  overShortLabel,
  type DayCloseSummary,
} from "@/lib/reports/day-close-core";

export const metadata = {
  title: "End of day — Tableside",
};

/**
 * End of day (20261116090000): the open day's figures, live, the drawer
 * count that closes it, and past closes as they were frozen. Owners and
 * managers, like Reports; a waiter gets a 404.
 */
export default async function EndOfDayPage() {
  const { restaurant } = await requireCurrentRestaurant();
  if (restaurant.role !== "owner" && restaurant.role !== "manager") notFound();

  // day_closes and these functions are newer than database.types.ts.
  const supabase = (await createClient()) as unknown as SupabaseClient;
  const [{ data: preview, error }, { data: closes }, print] = await Promise.all(
    [
      supabase.rpc("preview_day_close", { p_restaurant_id: restaurant.id }),
      supabase
        .from("day_closes")
        .select(
          "id, period_start, period_end, opening_float, counted_cash, expected_cash, over_short, note, summary",
        )
        .eq("restaurant_id", restaurant.id)
        .order("period_end", { ascending: false })
        .limit(30),
      getPrintCapabilities(restaurant.id),
    ],
  );
  if (error) throw error;
  const open = preview as {
    period_start: string;
    last_float: number | null;
    summary: DayCloseSummary;
  };
  const past = (closes ?? []) as {
    id: string;
    period_start: string;
    period_end: string;
    opening_float: number | string;
    counted_cash: number | string;
    expected_cash: number | string;
    over_short: number | string;
    note: string | null;
    summary: DayCloseSummary;
  }[];

  const when = (iso: string) =>
    new Date(iso).toLocaleString("en-US", {
      timeZone: restaurant.timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <Link
          href="/dashboard/reports"
          className="text-muted-foreground text-sm hover:underline"
        >
          ← Reports
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">End of day</h1>
        <p className="text-muted-foreground text-sm">
          Count the cash drawer and close the day. Each close keeps the
          day&apos;s figures as they were.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Today so far · since {when(open.period_start)}
          </CardTitle>
          <CardDescription>
            Everything paid since the last close, updated each time this page
            loads.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <DayCloseReport summary={open.summary} />
          <div className="border-t pt-5">
            <h2 className="mb-3 font-medium">Count the drawer</h2>
            <DayCloseForm
              restaurantId={restaurant.id}
              summary={open.summary}
              lastFloat={
                open.last_float === null ? null : Number(open.last_float)
              }
            />
          </div>
        </CardContent>
      </Card>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Past closes</h2>
        {past.length === 0 ? (
          <p className="text-muted-foreground text-sm">No days closed yet.</p>
        ) : (
          past.map((close) => {
            const money = (v: number | string) =>
              formatMoney(Number(v), close.summary.currency);
            const diff = Number(close.over_short);
            return (
              <details key={close.id} className="rounded-md border">
                <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <span className="font-medium">
                    {when(close.period_start)} – {when(close.period_end)}
                  </span>
                  <span className="flex gap-4 tabular-nums">
                    <span>Net {money(close.summary.payments.net)}</span>
                    <span
                      className={
                        Math.round(diff * 100) === 0
                          ? "text-muted-foreground"
                          : "text-destructive"
                      }
                    >
                      {overShortLabel(diff, money)}
                    </span>
                  </span>
                </summary>
                <div className="flex flex-col gap-4 border-t p-3">
                  <DayCloseReport summary={close.summary} />
                  <dl className="grid grid-cols-2 gap-1 text-sm tabular-nums sm:grid-cols-4">
                    {(
                      [
                        ["Starting cash", close.opening_float],
                        ["Expected", close.expected_cash],
                        ["Counted", close.counted_cash],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label}>
                        <dt className="text-muted-foreground text-xs">
                          {label}
                        </dt>
                        <dd>{money(value)}</dd>
                      </div>
                    ))}
                    <div>
                      <dt className="text-muted-foreground text-xs">
                        Difference
                      </dt>
                      <dd>{overShortLabel(diff, money)}</dd>
                    </div>
                  </dl>
                  {close.note && (
                    <p className="text-sm">
                      <span className="text-muted-foreground">Note: </span>
                      {close.note}
                    </p>
                  )}
                  {print.receipt && (
                    <PrintButton
                      restaurantId={restaurant.id}
                      kind="day_close"
                      dayCloseId={close.id}
                      label="Print"
                    />
                  )}
                </div>
              </details>
            );
          })
        )}
      </section>
    </div>
  );
}
