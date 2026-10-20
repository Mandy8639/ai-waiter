import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/orders/format";
import { formatReservationTime } from "@/lib/reservations/timezone";
import { getGuestInsights } from "@/lib/guests/insights";
import {
  aiSpendLift,
  average,
  busiestSlots,
  busyGrid,
  describeLift,
  hourLabel,
  percent,
} from "@/lib/guests/insights-core";
import {
  RANGE_LABELS,
  RANGE_PRESETS,
  isRangePreset,
  rangeBounds,
} from "@/lib/reports/range";

export const metadata = {
  title: "Guests — Tableside",
};

/**
 * Who comes, when, how they use the AI waiter and what they think
 * (docs/guest-insights.md). Money is in Reports; this page is about the
 * guests behind it.
 */
export default async function GuestsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { restaurant } = await requireCurrentRestaurant();
  // The database function is owner/manager only and raises for anyone
  // else; a 404 here matches Reports.
  if (restaurant.role !== "owner" && restaurant.role !== "manager") {
    notFound();
  }

  const params = await searchParams;
  const preset = isRangePreset(params.range) ? params.range : "30d";
  const range = rangeBounds(preset, restaurant.timezone);

  const supabase = await createClient();
  const { data: row } = await supabase
    .from("restaurants")
    .select("currency")
    .eq("id", restaurant.id)
    .maybeSingle();
  const currency = row?.currency ?? "USD";
  const money = (n: number | null) =>
    n === null ? "–" : formatMoney(n, currency);

  const insights = await getGuestInsights(restaurant.id, range);
  const { visits, ai, feedback, bookings, regulars } = insights;
  const lift = describeLift(aiSpendLift(ai));
  const slots = busiestSlots(insights.busy);
  const grid = busyGrid(insights.busy);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Guests</h1>
          <p className="text-muted-foreground text-sm">
            Who comes to {restaurant.name}, when, and how they use the AI
            waiter.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {RANGE_PRESETS.map((option) => (
            <Link
              key={option}
              href={`/dashboard/guests?range=${option}`}
              aria-current={option === preset ? "page" : undefined}
              className={
                option === preset
                  ? "bg-secondary rounded-md px-3 py-1.5 text-sm font-medium"
                  : "text-muted-foreground hover:bg-muted rounded-md px-3 py-1.5 text-sm"
              }
            >
              {RANGE_LABELS[option]}
            </Link>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Table visits"
          value={String(visits.visits)}
          note={`${percent(visits.orderingVisits, visits.visits)} ordered`}
        />
        <Stat
          label="Spend per visit"
          value={money(average(visits.spend, visits.orderingVisits))}
          note="visits that ordered"
        />
        <Stat
          label="Asked the AI waiter"
          value={percent(ai.chatVisits, visits.visits)}
          note={`${ai.questions} questions`}
        />
        <Stat
          label="Average rating"
          value={
            feedback.average === null
              ? "–"
              : `${feedback.average.toFixed(1)} / 5`
          }
          note={`${feedback.count} ratings`}
        />
      </div>

      <Section
        title="AI waiter"
        description="Guests who asked the AI waiter a question, against those who didn't."
      >
        {ai.chatVisits === 0 ? (
          <Empty>No guest asked the AI waiter anything in this period.</Empty>
        ) : (
          <div className="flex flex-col gap-3">
            <dl className="grid gap-3 sm:grid-cols-3">
              <Figure
                label="Visits that asked"
                value={`${ai.chatVisits}`}
                note={`${percent(ai.chatOrderingVisits, ai.chatVisits)} went on to order`}
              />
              <Figure
                label="Spend per visit, asked"
                value={money(average(ai.chatSpend, ai.chatOrderingVisits))}
              />
              <Figure
                label="Spend per visit, didn't ask"
                value={money(average(ai.otherSpend, ai.otherOrderingVisits))}
              />
            </dl>
            <p className="text-muted-foreground text-sm">
              {lift
                ? `Guests who asked the AI waiter spent ${lift} guests who didn't.`
                : "Once at least three visits on each side have ordered, this compares what they spent."}
            </p>
          </div>
        )}
      </Section>

      <Section
        title="Busy times"
        description={`Orders by day and hour, in ${restaurant.timezone.replace("_", " ")}.`}
      >
        {grid.rows.length === 0 ? (
          <Empty>No orders in this period.</Empty>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              Busiest:{" "}
              {slots.map((s, i) => (
                <span key={s.label}>
                  {i > 0 && ", "}
                  <strong>{s.label}</strong> ({s.orders})
                </span>
              ))}
            </p>
            <div className="overflow-x-auto">
              <table className="text-xs">
                <thead>
                  <tr>
                    <th />
                    {grid.hours.map((h) => (
                      <th
                        key={h}
                        className="text-muted-foreground px-0.5 pb-1 font-normal"
                      >
                        {hourLabel(h)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grid.rows.map((r) => (
                    <tr key={r.day}>
                      <th className="text-muted-foreground pr-2 text-left font-normal">
                        {r.day}
                      </th>
                      {r.cells.map((c, i) => (
                        <td key={i} className="p-0.5">
                          <div
                            title={`${r.day} ${hourLabel(grid.hours[i])}: ${c.orders} orders`}
                            className="bg-primary size-7 rounded-sm"
                            style={{
                              opacity:
                                c.orders === 0 ? 0.06 : 0.2 + 0.8 * c.level,
                            }}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Section>

      <Section
        title="Bookings and regulars"
        description="From reservations, where guests give a phone number. A guest is matched across bookings by that number; it's never shown here."
      >
        {bookings.bookings === 0 ? (
          <Empty>No bookings in this period.</Empty>
        ) : (
          <dl className="grid gap-3 sm:grid-cols-4">
            <Figure
              label="Bookings kept"
              value={`${bookings.kept}`}
              note={`${bookings.covers} guests seated`}
            />
            <Figure
              label="Returning guests"
              value={percent(bookings.returningGuests, bookings.guests)}
              note={`${bookings.returningGuests} of ${bookings.guests} had booked before`}
            />
            <Figure
              label="No-shows"
              value={percent(bookings.noShows, bookings.bookings)}
              note={`${bookings.noShows} bookings`}
            />
            <Figure
              label="Cancelled"
              value={percent(bookings.cancelled, bookings.bookings)}
              note={`${bookings.cancelled} bookings`}
            />
          </dl>
        )}
        {regulars.length > 0 && (
          <div className="mt-4 overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground text-xs">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Regular</th>
                  <th className="px-3 py-2 text-right font-medium">Visits</th>
                  <th className="px-3 py-2 text-right font-medium">Last</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {regulars.map((r, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2">{r.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.visits}
                    </td>
                    <td className="text-muted-foreground px-3 py-2 text-right">
                      {formatReservationTime(r.lastVisit, restaurant.timezone)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Ratings" description="What guests said after their meal.">
        {feedback.count === 0 ? (
          <Empty>No ratings in this period.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {[5, 4, 3, 2, 1].map((stars) => {
              const n = feedback.byRating[stars - 1];
              return (
                <div key={stars} className="flex items-center gap-3 text-sm">
                  <span className="w-12 tabular-nums">{stars} ★</span>
                  <div className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
                    <div
                      className="h-full rounded-full bg-amber-400"
                      style={{ width: `${(n / feedback.count) * 100}%` }}
                    />
                  </div>
                  <span className="text-muted-foreground w-8 text-right tabular-nums">
                    {n}
                  </span>
                </div>
              );
            })}
            <Link
              href="/dashboard/feedback"
              className="text-muted-foreground mt-1 text-sm underline underline-offset-4"
            >
              Read the comments in Feedback
            </Link>
          </div>
        )}
      </Section>
    </div>
  );
}

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 p-4">
        <span className="text-muted-foreground text-sm">{label}</span>
        <span className="text-2xl font-semibold">{value}</span>
        <span className="text-muted-foreground text-xs">{note}</span>
      </CardContent>
    </Card>
  );
}

function Figure({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="rounded-md border p-3">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
      {note && <dd className="text-muted-foreground text-xs">{note}</dd>}
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-5">
        <div>
          <h2 className="font-semibold">{title}</h2>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}
