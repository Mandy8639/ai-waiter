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
import {
  getUnpaidOrdersByTable,
  type UnpaidTable,
} from "@/lib/payments/unpaid-orders";
import { getPrintCapabilities } from "@/lib/printing/capabilities";
import { PrintButton } from "@/components/printing/print-button";
import { AdjustBillDialog } from "@/components/payments/adjust-bill-dialog";
import { SettleUpSync } from "@/components/payments/settle-up-sync";
import { SplitBillDialog } from "@/components/payments/split-bill-dialog";
import { SplitPanel } from "@/components/payments/split-panel";
import { ReceiptActions } from "@/components/payments/receipt-actions";
import { getRecentPayments } from "@/lib/payments/recent-payments";
import { paymentMethodLabel } from "@/lib/payments/method";
import {
  getOpenPaymentConflicts,
  getOrdersPayingOnPhone,
} from "@/lib/payments/payment-conflicts";
import { PaymentConflictsNotice } from "@/components/payments/payment-conflicts-notice";

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
 * lives on Reports next to refunds, where corrections belong. So is
 * changing a bill before it's paid (voids, comps, discounts: Adjust).
 *
 * Unpaid orders older than a day get their own section rather than
 * dropping off, so a walkout or a forgotten bill is seen and dealt with:
 * settled late, or written off by a manager.
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
    { recent: tables, older, splits },
    { data: cardProvider },
    { data: devices },
    print,
    recentPayments,
    conflicts,
    payingOnPhone,
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
    getPrintCapabilities(restaurant.id),
    getRecentPayments(restaurant.id),
    getOpenPaymentConflicts(restaurant.id),
    getOrdersPayingOnPhone(restaurant.id),
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
  const olderOutstanding = older.reduce((sum, t) => sum + t.total, 0);
  const currency = tables[0]?.currency ?? older[0]?.currency ?? "USD";
  // Owners and managers adjust directly; a waiter with a manager's PIN
  // (20261117090000).
  const canAdjust =
    restaurant.role === "owner" ||
    restaurant.role === "manager" ||
    restaurant.role === "staff";
  const adjustNeedsApproval = restaurant.role === "staff";

  const card = (table: UnpaidTable, showDates: boolean) => {
    // A split (staff's, or a diner's on their phone) holds its orders until
    // every part is paid; only the table's other orders can be paid as usual.
    const split = splits.find((s) =>
      table.orders.some((o) => s.orderIds.includes(o.id)),
    );
    const payable = split
      ? table.orders.filter((o) => !split.orderIds.includes(o.id))
      : table.orders;
    // Taking cash now could charge the guest twice (20261120090000).
    const onPhone = table.orders.some((o) => payingOnPhone.has(o.id));
    return (
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

          {onPhone && (
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <Badge>Paying on phone</Badge>
              <span className="text-muted-foreground">
                A guest is paying for this on their phone. Check with the table
                before taking payment, or they could pay twice.
              </span>
            </p>
          )}

          <ul className="flex flex-col gap-1 text-sm">
            {table.orders.map((order) => (
              <li
                key={order.id}
                className="flex items-center justify-between gap-2"
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium">#{order.orderNumber}</span>
                  <Badge variant="outline">{order.status}</Badge>
                  {showDates && (
                    <span className="text-muted-foreground text-xs">
                      {new Date(order.createdAt).toLocaleDateString("en-US", {
                        timeZone: restaurant.timezone,
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  )}
                </span>
                <span className="tabular-nums">
                  {order.discountTotal > 0 && (
                    <span className="text-muted-foreground mr-1 text-xs">
                      −{formatMoney(order.discountTotal, order.currency)}
                    </span>
                  )}
                  {formatMoney(order.total, order.currency)}
                </span>
              </li>
            ))}
          </ul>

          {split && (
            <SplitPanel
              restaurantId={restaurant.id}
              tableLabel={table.tableLabel}
              split={split}
              acceptsCash={acceptsCash}
              acceptsCardTerminal={acceptsCardTerminal}
              terminals={acceptsCard ? terminals : []}
              tippingEnabled={tippingEnabled}
            />
          )}

          <div className="flex flex-wrap items-center gap-2">
            {canAdjust && !split && (
              <AdjustBillDialog
                restaurantId={restaurant.id}
                tableLabel={table.tableLabel}
                orders={table.orders}
                currency={table.currency}
                needsApproval={adjustNeedsApproval}
              />
            )}
            {!split && table.total > 0 && (
              <SplitBillDialog
                restaurantId={restaurant.id}
                tableLabel={table.tableLabel}
                orderIds={table.orders.map((o) => o.id)}
                total={table.total}
                currency={table.currency}
              />
            )}
            {print.receipt && (
              <PrintButton
                restaurantId={restaurant.id}
                kind="bill"
                orderIds={table.orders.map((o) => o.id)}
                label="Print bill"
              />
            )}
          </div>

          {payable.length > 0 &&
            (acceptsCash || acceptsCardTerminal || acceptsCard) && (
              <div className="flex flex-wrap gap-2">
                {acceptsCard && terminals.length > 0 && (
                  <SquareTerminalDialog
                    restaurantId={restaurant.id}
                    tableLabel={table.tableLabel}
                    orders={payable}
                    currency={table.currency}
                    terminals={terminals}
                  />
                )}
                {acceptsCard && !paysThroughSquare && (
                  <TapToPayDialog
                    restaurantId={restaurant.id}
                    tableLabel={table.tableLabel}
                    orders={payable}
                    currency={table.currency}
                    tippingEnabled={tippingEnabled}
                  />
                )}
                {acceptsCash && (
                  <CashPaymentDialog
                    method="cash"
                    recordAction={recordCashPayment}
                    tableLabel={table.tableLabel}
                    orders={payable}
                    currency={table.currency}
                    tippingEnabled={tippingEnabled}
                  />
                )}
                {acceptsCardTerminal && (
                  <CashPaymentDialog
                    method="card_terminal"
                    recordAction={recordCardTerminalPayment}
                    tableLabel={table.tableLabel}
                    orders={payable}
                    currency={table.currency}
                    tippingEnabled={tippingEnabled}
                  />
                )}
              </div>
            )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <SettleUpSync restaurantId={restaurant.id} />
      <PaymentConflictsNotice
        conflicts={conflicts}
        canClose={restaurant.role === "owner" || restaurant.role === "manager"}
      />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settle up</h1>
          <p className="text-muted-foreground text-sm">
            Orders at {restaurant.name} that haven&apos;t been paid for yet.
            This page updates by itself.
          </p>
        </div>
        {print.drawer && (
          <PrintButton
            restaurantId={restaurant.id}
            kind="drawer"
            label="Open drawer"
          />
        )}
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
              Nothing outstanding from the last day.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tables.map((table) => card(table, false))}
        </div>
      )}

      {older.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">
                Unpaid for more than a day
              </h2>
              <p className="text-muted-foreground text-sm">
                {canAdjust
                  ? "Settle these if they were paid and not recorded, or write off a table that walked out (Adjust → Write off)."
                  : "Settle these if they were paid and not recorded. An owner or manager can write off a table that walked out."}
              </p>
            </div>
            <p className="text-lg font-semibold tabular-nums">
              {formatMoney(olderOutstanding, currency)}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {older.map((table) => card(table, true))}
          </div>
        </section>
      )}

      {recentPayments.length > 0 && (
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              Paid recently
            </h2>
            <p className="text-muted-foreground text-sm">
              Print or email a guest their receipt.
            </p>
          </div>
          <ul className="divide-y rounded-md border text-sm">
            {recentPayments.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 p-3"
              >
                <span className="flex flex-col">
                  <span className="font-medium">
                    {p.tableLabels.length > 0 &&
                      `${p.tableLabels.join(", ")} · `}
                    {p.orderNumbers.length > 0
                      ? p.orderNumbers.map((n) => `#${n}`).join(", ")
                      : p.splitPart
                        ? "Part of a split bill"
                        : "Payment"}{" "}
                    · {formatMoney(p.total, p.currency)}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {p.method === "card" && p.cardPresent
                      ? "Card (in person)"
                      : paymentMethodLabel(p.method)}{" "}
                    ·{" "}
                    {new Date(p.paidAt).toLocaleTimeString("en-US", {
                      timeZone: restaurant.timezone,
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                </span>
                <ReceiptActions
                  restaurantId={restaurant.id}
                  paymentId={p.id}
                  canPrint={print.receipt}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
