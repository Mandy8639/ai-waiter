import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { CashPaymentDialog } from "@/components/payments/cash-payment-dialog";
import { TapToPayDialog } from "@/components/payments/tap-to-pay-dialog";
import {
  SquareTerminalDialog,
  type PairedTerminal,
} from "@/components/payments/square-terminal-dialog";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/orders/format";
import {
  recordCardTerminalPayment,
  recordCashPayment,
} from "@/lib/payments/cash-actions";
import { getUnpaidOrdersByTable } from "@/lib/payments/unpaid-orders";

export const metadata = {
  title: "Settle up — Tableside",
};

/**
 * What is still owed, by table.
 *
 * Open to every restaurant member, unlike Reports. That is a deliberate
 * match to record_cash_payment(), which any member may call: the person
 * holding the notes is the waiter, and restricting this to owner/manager
 * would just be worked around by everyone sharing one login — which is
 * worse than letting a waiter record what they were handed.
 *
 * Reversing a mistake is the part that is owner/manager gated, and it
 * lives on Reports next to refunds, where corrections belong.
 */
export default async function CheckoutPage() {
  const { restaurant } = await requireCurrentRestaurant();

  const supabase = await createClient();
  // Square phase 3 (20261111090000) is newer than database.types.ts.
  const loose = supabase as unknown as {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown }>;
    from: (table: string) => {
      select: (columns: string) => {
        eq: (
          column: string,
          value: string,
        ) => {
          eq: (
            column: string,
            value: string,
          ) => Promise<{ data: { device_id: string; name: string }[] | null }>;
        };
      };
    };
  };
  const [
    { data: settings },
    tables,
    { data: cardProvider },
    { data: devices },
  ] = await Promise.all([
    supabase
      .from("restaurant_settings")
      .select("accept_cash, accept_card_terminal, accept_card, tipping_enabled")
      .eq("restaurant_id", restaurant.id)
      .maybeSingle(),
    getUnpaidOrdersByTable(restaurant.id),
    loose.rpc("restaurant_card_provider", { p_restaurant_id: restaurant.id }),
    loose
      .from("pos_devices")
      .select("device_id, name")
      .eq("restaurant_id", restaurant.id)
      .eq("status", "paired"),
  ]);
  // Square restaurants take cards on a paired Square Terminal; Tap to Pay
  // is Stripe's and stays off for them.
  const paysThroughSquare = cardProvider === "square";
  const terminals: PairedTerminal[] = paysThroughSquare
    ? (devices ?? []).map((d) => ({ deviceId: d.device_id, name: d.name }))
    : [];

  const acceptsCash = settings?.accept_cash ?? false;
  const acceptsCardTerminal = settings?.accept_card_terminal ?? false;
  const tippingEnabled = settings?.tipping_enabled ?? false;
  // Tap to Pay needs card payments on; it only appears inside the staff
  // app, and the database refuses it if the Stripe account can't charge.
  const acceptsCard = settings?.accept_card ?? false;

  const outstanding = tables.reduce((sum, t) => sum + t.total, 0);
  const currency = tables[0]?.currency ?? "USD";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settle up</h1>
          <p className="text-muted-foreground text-sm">
            Orders at {restaurant.name} that haven&apos;t been paid for yet.
          </p>
        </div>
        {tables.length > 0 && (
          <div className="text-right">
            <p className="text-muted-foreground text-sm">Outstanding</p>
            <p className="text-2xl font-semibold tabular-nums">
              {formatMoney(outstanding, currency)}
            </p>
          </div>
        )}
      </div>

      {/* Said before any button is offered rather than after one fails:
          record_in_person_payment() refuses outright when a method is
          switched off, and a staff member cannot fix that from here. */}
      {!acceptsCash && !acceptsCardTerminal && (
        <Card>
          <CardContent className="p-4 text-sm">
            <span className="font-medium">
              Cash and card-machine payments aren&apos;t switched on.
            </span>{" "}
            <span className="text-muted-foreground">
              An owner or manager can turn it on in{" "}
              <Link href="/dashboard/payments" className="underline">
                Payments
              </Link>
              .
            </span>
          </CardContent>
        </Card>
      )}

      {tables.length === 0 ? (
        <Card>
          <CardContent className="p-6">
            <p className="text-muted-foreground text-sm">
              Nothing outstanding. Every order from the last day has been paid
              for or cancelled.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tables.map((table) => (
            <Card key={table.tableId}>
              <CardContent className="flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{table.tableLabel}</p>
                    <p className="text-muted-foreground text-xs">
                      {table.orders.length}{" "}
                      {table.orders.length === 1 ? "order" : "orders"}
                    </p>
                  </div>
                  <p className="text-lg font-semibold tabular-nums">
                    {formatMoney(table.total, table.currency)}
                  </p>
                </div>

                <ul className="flex flex-col gap-1 text-sm">
                  {table.orders.map((order) => (
                    <li
                      key={order.id}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="flex items-center gap-2">
                        <span className="font-medium">
                          #{order.orderNumber}
                        </span>
                        <Badge variant="outline">{order.status}</Badge>
                      </span>
                      <span className="tabular-nums">
                        {formatMoney(order.total, order.currency)}
                      </span>
                    </li>
                  ))}
                </ul>

                {(acceptsCash || acceptsCardTerminal || acceptsCard) && (
                  <div className="flex flex-wrap gap-2">
                    {acceptsCard && terminals.length > 0 && (
                      <SquareTerminalDialog
                        restaurantId={restaurant.id}
                        tableLabel={table.tableLabel}
                        orders={table.orders}
                        currency={table.currency}
                        terminals={terminals}
                      />
                    )}
                    {acceptsCard && !paysThroughSquare && (
                      <TapToPayDialog
                        restaurantId={restaurant.id}
                        tableLabel={table.tableLabel}
                        orders={table.orders}
                        currency={table.currency}
                        tippingEnabled={tippingEnabled}
                      />
                    )}
                    {acceptsCash && (
                      <CashPaymentDialog
                        method="cash"
                        recordAction={recordCashPayment}
                        tableLabel={table.tableLabel}
                        orders={table.orders}
                        currency={table.currency}
                        tippingEnabled={tippingEnabled}
                      />
                    )}
                    {acceptsCardTerminal && (
                      <CashPaymentDialog
                        method="card_terminal"
                        recordAction={recordCardTerminalPayment}
                        tableLabel={table.tableLabel}
                        orders={table.orders}
                        currency={table.currency}
                        tippingEnabled={tippingEnabled}
                      />
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
