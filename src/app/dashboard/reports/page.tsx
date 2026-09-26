import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/orders/format";
import { RefundDialog } from "@/components/reports/refund-dialog";
import { ReverseCashDialog } from "@/components/reports/reverse-cash-dialog";
import { refundPayment } from "@/lib/payments/refund-actions";
import { reverseCashPayment } from "@/lib/payments/cash-actions";
import { formatReservationTime } from "@/lib/reservations/timezone";
import { getDishFunnel, getReportData } from "@/lib/reports/queries";
import { formatRate, openToOrderRate } from "@/lib/reports/funnel";
import {
  RANGE_LABELS,
  RANGE_PRESETS,
  isRangePreset,
  rangeBounds,
} from "@/lib/reports/range";

export const metadata = {
  title: "Reports — Tableside",
};

const STATUS_LABELS: Record<string, string> = {
  succeeded: "Paid",
  pending: "Not completed",
  failed: "Declined",
  cancelled: "Abandoned",
  reversed: "Reversed",
};

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { restaurant } = await requireCurrentRestaurant();

  // The database functions are owner/manager gated and raise for anyone
  // else. Checking here too means a waiter gets a 404 rather than an
  // error page — the page simply does not exist for them.
  if (restaurant.role !== "owner" && restaurant.role !== "manager") {
    notFound();
  }

  const params = await searchParams;
  const preset = isRangePreset(params.range) ? params.range : "today";
  const range = rangeBounds(preset, restaurant.timezone);

  const supabase = await createClient();
  const { data: row } = await supabase
    .from("restaurants")
    .select("currency")
    .eq("id", restaurant.id)
    .maybeSingle();
  const currency = row?.currency ?? "USD";

  const [{ summary, byMethod, payments, items }, funnel] = await Promise.all([
    getReportData(restaurant.id, range),
    getDishFunnel(restaurant.id, range),
  ]);

  const money = (value: string | number) =>
    formatMoney(Number(value), currency);
  const hasPendingRefunds = Number(summary.refundsPending) > 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Reports</h1>
          <p className="text-muted-foreground text-sm">
            What {restaurant.name} took, in{" "}
            {restaurant.timezone.replace("_", " ")}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* A plain link, not a button: the response is a file, so letting
              the browser handle the navigation is what makes the download
              work without any client-side code. `preset` rather than the
              resolved bounds, so the file always matches what is on
              screen. */}
          <a
            href={`/dashboard/reports/export?range=${preset}`}
            className="text-muted-foreground hover:bg-muted rounded-md border px-3 py-1.5 text-sm"
          >
            Export CSV
          </a>
          {RANGE_PRESETS.map((option) => (
            <Link
              key={option}
              href={`/dashboard/reports?range=${option}`}
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

      {/* Gross, refunded and net are all shown rather than one "takings"
          figure. A single number would leave the reader guessing whether
          refunds were already deducted, which is exactly the ambiguity
          that makes a report untrustworthy. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="flex flex-col gap-1 p-4">
            <span className="text-muted-foreground text-sm">Net takings</span>
            <span className="text-2xl font-semibold">{money(summary.net)}</span>
            <span className="text-muted-foreground text-xs">
              after {money(summary.refunded)} refunded
            </span>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-1 p-4">
            <span className="text-muted-foreground text-sm">Gross taken</span>
            <span className="text-2xl font-semibold">
              {money(summary.gross)}
            </span>
            <span className="text-muted-foreground text-xs">
              {summary.paymentCount}{" "}
              {summary.paymentCount === 1 ? "payment" : "payments"}
            </span>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-1 p-4">
            <span className="text-muted-foreground text-sm">Tips</span>
            <span className="text-2xl font-semibold">
              {money(summary.tips)}
            </span>
            <span className="text-muted-foreground text-xs">
              included in gross
            </span>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-1 p-4">
            <span className="text-muted-foreground text-sm">Orders paid</span>
            <span className="text-2xl font-semibold">{summary.orderCount}</span>
            <span className="text-muted-foreground text-xs">
              {money(summary.averageOrderValue)} average
            </span>
          </CardContent>
        </Card>
      </div>

      {hasPendingRefunds && (
        <Card>
          <CardContent className="p-4 text-sm">
            <span className="font-medium">
              {money(summary.refundsPending)} of refunds is still settling.
            </span>{" "}
            <span className="text-muted-foreground">
              Not yet deducted from net takings — it will be once Stripe
              confirms.
            </span>
          </CardContent>
        </Card>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">How they paid</h2>
        {byMethod.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing taken in this period.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {byMethod.map((m) => (
              <Card key={m.method}>
                <CardContent className="flex items-center justify-between p-4">
                  <div className="flex flex-col">
                    <span className="font-medium capitalize">{m.method}</span>
                    <span className="text-muted-foreground text-xs">
                      {m.paymentCount}{" "}
                      {m.paymentCount === 1 ? "payment" : "payments"}
                    </span>
                  </div>
                  <div className="flex flex-col items-end">
                    <span className="font-semibold">{money(m.net)}</span>
                    {Number(m.refunded) > 0 && (
                      <span className="text-muted-foreground text-xs">
                        {money(m.gross)} less {money(m.refunded)}
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Best sellers</h2>
        {items.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No orders in this period.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-left">
                <tr>
                  <th className="py-2 font-medium">Item</th>
                  <th className="py-2 text-right font-medium">Sold</th>
                  <th className="py-2 text-right font-medium">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.itemName} className="border-t">
                    <td className="py-2">{item.itemName}</td>
                    <td className="py-2 text-right">{item.quantitySold}</td>
                    <td className="py-2 text-right">{money(item.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Dish funnel</h2>
        <p className="text-muted-foreground text-sm">
          How many visits opened each dish, added it to their order and ordered
          it. Each visit counts once per dish. Diners aren&apos;t identified:
          only these counts are kept.
        </p>
        {funnel.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No dishes opened or ordered in this period. Counting started when
            this report was switched on, so earlier days are empty.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-left">
                <tr>
                  <th className="py-2 font-medium">Dish</th>
                  <th className="py-2 text-right font-medium">Opened</th>
                  <th className="py-2 text-right font-medium">Added</th>
                  <th className="py-2 text-right font-medium">Ordered</th>
                  <th
                    className="py-2 text-right font-medium"
                    title="Of the visits that opened the dish, the share that ordered it"
                  >
                    Opened → ordered
                  </th>
                </tr>
              </thead>
              <tbody>
                {funnel.map((row) => (
                  <tr key={row.dishId} className="border-t">
                    <td className="py-2">{row.dishName}</td>
                    <td className="py-2 text-right">{row.opened}</td>
                    <td className="py-2 text-right">{row.added}</td>
                    <td className="py-2 text-right">{row.ordered}</td>
                    <td className="py-2 text-right">
                      {formatRate(openToOrderRate(row))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-muted-foreground text-xs">
          &ldquo;Added&rdquo; and &ldquo;Ordered&rdquo; include dishes the AI
          waiter added, which diners may never have opened.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Payments</h2>
        {/* Failed and abandoned attempts are listed on purpose: "the
            customer says they paid" is usually answered by one of them. */}
        <p className="text-muted-foreground text-sm">
          Includes attempts that did not complete.
        </p>
        {payments.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No payment attempts in this period.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-left">
                <tr>
                  <th className="py-2 font-medium">When</th>
                  <th className="py-2 font-medium">Orders</th>
                  <th className="py-2 font-medium">Method</th>
                  <th className="py-2 font-medium">Status</th>
                  <th className="py-2 text-right font-medium">Amount</th>
                  <th className="py-2 text-right font-medium">
                    <span className="sr-only">Refund or reverse</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.paymentId} className="border-t">
                    <td className="py-2 whitespace-nowrap">
                      {formatReservationTime(
                        p.paidAt ?? p.createdAt,
                        restaurant.timezone,
                      )}
                    </td>
                    <td className="py-2">
                      {p.orderNumbers.length > 0
                        ? p.orderNumbers.map((n) => `#${n}`).join(", ")
                        : "—"}
                    </td>
                    <td className="py-2 capitalize">{p.method}</td>
                    <td className="py-2">
                      <Badge
                        variant={
                          p.status === "succeeded" ? "secondary" : "outline"
                        }
                      >
                        {STATUS_LABELS[p.status] ?? p.status}
                      </Badge>
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">
                      {money(p.totalAmount)}
                      {Number(p.refunded) > 0 && (
                        <span className="text-muted-foreground block text-xs">
                          {money(p.refunded)} refunded
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      {/* Only a settled card payment with money left can be
                          refunded. Cash is reversed instead (below), and an
                          attempt that never completed took nothing to give
                          back — start_refund() refuses both anyway, so this
                          only avoids offering a button that cannot work. */}
                      {p.status === "succeeded" &&
                        p.method === "card" &&
                        Number(p.totalAmount) - Number(p.refunded) > 0 && (
                          <RefundDialog
                            refundAction={refundPayment.bind(null, p.paymentId)}
                            paymentLabel={
                              p.orderNumbers.length > 0
                                ? p.orderNumbers.map((n) => `#${n}`).join(", ")
                                : "this payment"
                            }
                            refundableAmount={String(
                              Number(p.totalAmount) - Number(p.refunded),
                            )}
                            currency={p.currency}
                          />
                        )}
                      {/* Cash is reversed, not refunded: no money moves, the
                          record simply says it was never taken. Only a
                          settled cash payment qualifies — a reversed one is
                          already done, and reverse_cash_payment() refuses
                          both that and any card payment regardless. */}
                      {p.status === "succeeded" && p.method === "cash" && (
                        <ReverseCashDialog
                          reverseAction={reverseCashPayment.bind(
                            null,
                            p.paymentId,
                            { amount: p.totalAmount, currency: p.currency },
                          )}
                          paymentLabel={
                            p.orderNumbers.length > 0
                              ? p.orderNumbers.map((n) => `#${n}`).join(", ")
                              : "this payment"
                          }
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
