import Link from "next/link";
import { notFound } from "next/navigation";
import { Star, ThumbsDown, ThumbsUp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { getFeedbackOverview } from "@/lib/feedback/queries";
import {
  getGoogleReviewTapCount,
  getGoogleReviewUrl,
} from "@/lib/reviews/queries";
import { LOW_RATING } from "@/lib/feedback/core";
import { cn } from "@/lib/utils";

export const metadata = {
  title: "Feedback — Tableside",
};

const PERIODS = [7, 30, 90] as const;

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex" aria-label={`${rating} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          aria-hidden="true"
          className={cn(
            "size-4",
            n <= rating
              ? "fill-amber-400 text-amber-500"
              : "text-muted-foreground/40",
          )}
        />
      ))}
    </span>
  );
}

/**
 * Phase N: what diners said about their visit and the dishes, privately.
 * Owners and managers only; the page doesn't exist for anyone else (the
 * database shows them nothing regardless).
 */
export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const { restaurant } = await requireCurrentRestaurant();
  if (restaurant.role !== "owner" && restaurant.role !== "manager") {
    notFound();
  }

  const { days: raw } = await searchParams;
  const days = PERIODS.find((p) => String(p) === raw) ?? 30;
  const [{ summary, servedOrders, entries, dishes }, reviewUrl, reviewTaps] =
    await Promise.all([
      getFeedbackOverview(restaurant.id, days),
      getGoogleReviewUrl(restaurant.id),
      getGoogleReviewTapCount(restaurant.id, days),
    ]);
  const responseRate =
    servedOrders > 0 ? Math.round((summary.count / servedOrders) * 100) : null;
  const maxBar = Math.max(1, ...Object.values(summary.distribution));
  const timeFormat = new Intl.DateTimeFormat("en-US", {
    timeZone: restaurant.timezone ?? "UTC",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Feedback</h1>
        <p className="text-muted-foreground text-sm">
          Diners can rate their visit and each dish once their order has been
          served. It&apos;s private: only owners and managers see it, and it
          isn&apos;t posted anywhere. When someone gives one or two stars,
          they&apos;re offered someone coming over, and if they say yes it
          arrives as a waiter call.
        </p>
      </div>

      <nav aria-label="Period" className="flex gap-2">
        {PERIODS.map((p) => (
          <Link
            key={p}
            href={`/dashboard/feedback?days=${p}`}
            aria-current={p === days ? "page" : undefined}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm",
              p === days
                ? "bg-primary text-primary-foreground border-primary"
                : "hover:bg-muted",
            )}
          >
            Last {p} days
          </Link>
        ))}
      </nav>

      <p className="text-muted-foreground text-sm">
        {reviewUrl ? (
          <>
            <span className="text-foreground font-medium">
              {reviewTaps ?? 0} {reviewTaps === 1 ? "guest" : "guests"}
            </span>{" "}
            opened your Google review page in the last {days} days. Google
            doesn&apos;t tell us who went on to post.
          </>
        ) : (
          <>
            Add your Google review link in{" "}
            <Link
              href="/dashboard/settings"
              className="text-primary underline-offset-4 hover:underline"
            >
              Settings
            </Link>{" "}
            and guests will be offered it after their meal.
          </>
        )}
      </p>

      {summary.count === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground py-6 text-sm">
            No feedback in the last {days} days yet. Diners see &quot;How was
            everything?&quot; on their order page once you mark the order served
            on the kitchen board.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="grid gap-6 py-5 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <p className="text-muted-foreground text-xs font-medium uppercase">
                Average
              </p>
              <p className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold">
                  {summary.average?.toFixed(1)}
                </span>
                <span className="text-muted-foreground text-sm">
                  from {summary.count}{" "}
                  {summary.count === 1 ? "rating" : "ratings"}
                </span>
              </p>
              {responseRate !== null && (
                <p className="text-muted-foreground text-sm">
                  {responseRate}% of {servedOrders} served orders rated
                </p>
              )}
              {summary.low > 0 && (
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  {summary.low} gave {LOW_RATING} stars or fewer
                </p>
              )}
            </div>
            <ul className="flex flex-col gap-1" aria-label="Ratings by stars">
              {([5, 4, 3, 2, 1] as const).map((n) => (
                <li key={n} className="flex items-center gap-2 text-sm">
                  <span className="w-6 text-right tabular-nums">{n}★</span>
                  <span className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
                    <span
                      className={cn(
                        "block h-full rounded-full",
                        n <= LOW_RATING ? "bg-amber-500" : "bg-primary",
                      )}
                      style={{
                        width: `${(summary.distribution[n] / maxBar) * 100}%`,
                      }}
                    />
                  </span>
                  <span className="text-muted-foreground w-8 tabular-nums">
                    {summary.distribution[n]}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {dishes.length > 0 && (
        <section
          aria-labelledby="dishes-heading"
          className="flex flex-col gap-2"
        >
          <h2 id="dishes-heading" className="font-medium">
            Dishes
          </h2>
          <p className="text-muted-foreground text-sm">
            Most disliked first — the dish to look at is at the top.
          </p>
          <ul className="divide-y rounded-lg border">
            {dishes.map((d, i) => (
              <li
                key={`${d.dishName}:${i}`}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <span>{d.dishName}</span>
                <span className="text-muted-foreground flex items-center gap-3 tabular-nums">
                  <span className="inline-flex items-center gap-1">
                    <ThumbsUp className="size-3.5" aria-hidden="true" />
                    <span className="sr-only">Liked by</span>
                    {d.up}
                  </span>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1",
                      d.down > 0 && "text-amber-700 dark:text-amber-400",
                    )}
                  >
                    <ThumbsDown className="size-3.5" aria-hidden="true" />
                    <span className="sr-only">Not liked by</span>
                    {d.down}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {entries.length > 0 && (
        <section
          aria-labelledby="entries-heading"
          className="flex flex-col gap-2"
        >
          <h2 id="entries-heading" className="font-medium">
            What diners said
          </h2>
          <ul className="flex flex-col gap-3">
            {entries.map((e) => (
              <li
                key={e.orderId}
                className={cn(
                  "flex flex-col gap-2 rounded-lg border p-3",
                  e.rating <= LOW_RATING &&
                    "border-amber-300 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20",
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Stars rating={e.rating} />
                  <span className="text-muted-foreground text-xs">
                    {e.tableLabel}
                    {e.orderNumber !== null && ` · Order #${e.orderNumber}`}
                    {" · "}
                    {timeFormat.format(new Date(e.createdAt))}
                  </span>
                </div>
                {e.comment && (
                  <p className="text-sm whitespace-pre-line">{e.comment}</p>
                )}
                {e.dishes.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5">
                    {e.dishes.map((d, i) => (
                      <li
                        key={i}
                        className="bg-muted inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
                      >
                        {d.liked ? (
                          <ThumbsUp className="size-3" aria-label="Liked" />
                        ) : (
                          <ThumbsDown
                            className="size-3 text-amber-700 dark:text-amber-400"
                            aria-label="Didn't like"
                          />
                        )}
                        {d.dishName}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          {entries.length < summary.count && (
            <p className="text-muted-foreground text-xs">
              Showing the latest {entries.length} of {summary.count}.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
