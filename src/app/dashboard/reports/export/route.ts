import { NextResponse, type NextRequest } from "next/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { createClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observability/report";
import { csvFilename, toCsv } from "@/lib/reports/csv";
import { isRangePreset, rangeBounds } from "@/lib/reports/range";
import { paymentMethodLabel } from "@/lib/payments/method";

/**
 * Reports as CSV, for the bookkeeping that happens outside this app.
 *
 * A route handler rather than a server action: the browser has to receive
 * a file with a Content-Disposition header, which an action returning a
 * value cannot do.
 *
 * PAGINATION IS NOT AN OPTIMISATION HERE
 *
 * get_payment_history() caps at 500 rows per call. An export that issued
 * one call and stopped would hand someone a file that looks complete,
 * balances against nothing, and gives no sign that a busy month was cut
 * off at row 500. So it pages until the source is exhausted — the same
 * reasoning as showing gross and net separately on the page: a figure a
 * reader cannot tell is partial is worse than no figure.
 */

/** Matches the function's own cap, so each call asks for the most it can return. */
const PAGE_SIZE = 500;

/** A stop far above any real restaurant's month, so a pathological loop cannot run forever. */
const MAX_PAGES = 40;

interface PaymentHistoryRow {
  payment_id: string;
  created_at: string;
  paid_at: string | null;
  status: string;
  method: string;
  amount: string;
  tip_amount: string;
  total_amount: string;
  refunded: string;
  currency: string;
  order_numbers: number[] | null;
  stripe_payment_intent_id: string | null;
  reversed_at: string | null;
}

export async function GET(request: NextRequest) {
  const { restaurant } = await requireCurrentRestaurant();

  // The database function is owner/manager gated and raises for anyone
  // else; checking here too turns that into a clean 404 rather than a
  // stack trace, exactly as the reports page does.
  if (restaurant.role !== "owner" && restaurant.role !== "manager") {
    return new NextResponse("Not found", { status: 404 });
  }

  const rangeParam = request.nextUrl.searchParams.get("range");
  const preset = isRangePreset(rangeParam) ? rangeParam : "today";
  const range = rangeBounds(preset, restaurant.timezone);

  const supabase = await createClient();
  const rows: PaymentHistoryRow[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await supabase.rpc("get_payment_history", {
      target_restaurant_id: restaurant.id,
      p_from: range.from,
      p_to: range.to,
      p_limit: PAGE_SIZE,
      p_offset: page * PAGE_SIZE,
    });

    if (error) {
      // Refusing is the only honest option: a partial file is
      // indistinguishable from a complete one once it is on someone's
      // disk, and this one is used to reconcile money.
      reportError(error, {
        scope: "reports.export",
        extra: { restaurantId: restaurant.id, preset, page },
      });
      return new NextResponse("Could not build the export. Please retry.", {
        status: 500,
      });
    }

    const batch = (data ?? []) as PaymentHistoryRow[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  const csv = toCsv(
    [
      "Payment ID",
      "Created",
      "Paid at",
      "Status",
      "Method",
      "Orders",
      "Amount",
      "Tip",
      "Total",
      "Refunded",
      "Currency",
      "Reversed at",
      "Stripe payment intent",
    ],
    rows.map((r) => [
      r.payment_id,
      r.created_at,
      r.paid_at,
      r.status,
      paymentMethodLabel(r.method),
      // Space-separated rather than comma: a comma would force the field
      // to be quoted for no benefit, and "#3 #4" reads fine in a cell.
      (r.order_numbers ?? []).map((n) => `#${n}`).join(" "),
      r.amount,
      r.tip_amount,
      r.total_amount,
      r.refunded,
      r.currency,
      r.reversed_at,
      r.stripe_payment_intent_id,
    ]),
  );

  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${csvFilename("payments", range.from, range.to)}"`,
      // A report of money must never be served from a cache: the same URL
      // returns different content as the day goes on.
      "cache-control": "no-store",
    },
  });
}
