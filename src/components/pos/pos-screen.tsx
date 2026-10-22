"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  CircleCheck,
  Minus,
  Plus,
  Search,
  Send,
  StickyNote,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CashPaymentDialog } from "@/components/payments/cash-payment-dialog";
import { TapToPayDialog } from "@/components/payments/tap-to-pay-dialog";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/orders/format";
import {
  recordCardTerminalPayment,
  recordCashPayment,
} from "@/lib/payments/cash-actions";
import type { UnpaidOrder } from "@/lib/payments/unpaid-orders";
import { sendTicket } from "@/lib/pos/actions";
import {
  addLine,
  makeLine,
  needsChoices,
  searchPosMenu,
  setLineNotes,
  setQuantity,
  ticketTotals,
  toOrderLines,
  type PosCategory,
  type PosDish,
  type PosTable,
  type TicketLine,
} from "@/lib/pos/pos-core";
import { DishOptionsDialog } from "./dish-options-dialog";

interface Sent {
  order: UnpaidOrder;
  where: string;
  counter: boolean;
  /** How it was paid, once it has been, from this screen. */
  paidBy?: string;
}

/**
 * Where, what, send: pick a table or the counter, tap dishes onto the
 * ticket, send it to the kitchen. Laid out for a tablet at the counter
 * (three columns), stacking on a phone.
 *
 * A send that fails keeps the ticket and its idempotency key, so pressing
 * Send again after a dropped connection can't ring the order up twice;
 * a fresh key is made only once an order has gone through.
 */
export function PosScreen({
  restaurantId,
  menu,
  tables,
  currency,
  taxRate,
  serviceChargeRate,
  payments,
}: {
  restaurantId: string;
  menu: PosCategory[];
  tables: PosTable[];
  currency: string;
  taxRate: number;
  serviceChargeRate: number;
  payments: {
    cash: boolean;
    cardMachine: boolean;
    card: boolean;
    tipping: boolean;
  };
}) {
  const [tableId, setTableId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(
    menu[0]?.id ?? null,
  );
  const [query, setQuery] = useState("");
  const [lines, setLines] = useState<TicketLine[]>([]);
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [pickupName, setPickupName] = useState("");
  const [optionsDish, setOptionsDish] = useState<PosDish | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState("");
  const [dialogKey, setDialogKey] = useState(0);
  const [idempotencyKey, setIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  );
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [sending, startSending] = useTransition();

  const counters = tables.filter((t) => t.kind === "counter");
  const diningTables = tables.filter((t) => t.kind === "table");
  const table = tables.find((t) => t.id === tableId) ?? null;
  const isCounter = table?.kind === "counter";

  const onNowByDish = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const c of menu) for (const d of c.dishes) map.set(d.id, c.onNow);
    return map;
  }, [menu]);

  const category = menu.find((c) => c.id === categoryId) ?? menu[0] ?? null;
  const searching = query.trim().length > 0;
  const shownDishes = searching
    ? searchPosMenu(menu, query)
    : (category?.dishes ?? []);

  const totals = ticketTotals(lines, taxRate, serviceChargeRate);
  const money = (v: number) => formatMoney(v, currency);

  function chooseTable(id: string) {
    setTableId(id);
    setError(null);
  }

  function addToTicket(line: TicketLine) {
    setLines((prev) => addLine(prev, line));
    setSent(null);
    setError(null);
  }

  function tapDish(dish: PosDish) {
    if (needsChoices(dish)) {
      openOptions(dish);
      return;
    }
    addToTicket(makeLine(dish, []));
  }

  function openOptions(dish: PosDish) {
    setDialogKey((k) => k + 1);
    setOptionsDish(dish);
  }

  function startNote(line: TicketLine) {
    setEditingKey(line.key);
    setDraftNote(line.notes);
  }

  function saveNote() {
    if (editingKey) {
      setLines((prev) => setLineNotes(prev, editingKey, draftNote));
    }
    setEditingKey(null);
  }

  function markPaid(by: string) {
    setSent((prev) => (prev ? { ...prev, paidBy: by } : prev));
  }

  function nextOrder() {
    setSent(null);
    setLines([]);
    setNote("");
    setShowNote(false);
    setPickupName("");
    setError(null);
    if (isCounter) setTableId(null);
  }

  function send() {
    if (!table || lines.length === 0) return;
    setError(null);
    startSending(async () => {
      const result = await sendTicket({
        restaurantId,
        tableId: table.id,
        idempotencyKey,
        lines: toOrderLines(lines),
        note: note.trim() || undefined,
        pickupName: isCounter ? pickupName.trim() || undefined : undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSent({
        order: result.order,
        where: isCounter ? pickupName.trim() || "Walk-in" : table.label,
        counter: isCounter,
      });
      setLines([]);
      setNote("");
      setShowNote(false);
      setIdempotencyKey(crypto.randomUUID());
    });
  }

  if (menu.length === 0) {
    return (
      <Alert>
        <AlertDescription>
          There&apos;s nothing on the menu yet. Add dishes in Menu first.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    // Columns follow the space the screen actually has (a container), not
    // the window: the dashboard's sidebar takes a third of a small tablet.
    <div className="@container">
      <div className="grid gap-4 @2xl:grid-cols-[minmax(0,1fr)_20rem] @5xl:grid-cols-[13rem_minmax(0,1fr)_22rem]">
        {/* Where */}
        <section
          aria-labelledby="pos-where"
          className="flex flex-col gap-3 @2xl:col-span-2 @5xl:col-span-1"
        >
          <h2 id="pos-where" className="text-sm font-medium">
            Where
          </h2>
          <div className="flex flex-col gap-2 @2xl:flex-row @5xl:flex-col">
            {counters.length > 0 ? (
              <div className="flex flex-col gap-2 @2xl:w-44 @2xl:shrink-0 @5xl:w-full">
                {counters.map((c) => (
                  <PlaceButton
                    key={c.id}
                    selected={tableId === c.id}
                    onClick={() => chooseTable(c.id)}
                    className="w-full"
                  >
                    {counters.length === 1
                      ? "Takeout / phone"
                      : `Takeout · ${c.label}`}
                  </PlaceButton>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-xs @2xl:w-44 @2xl:shrink-0 @5xl:w-full">
                For takeout and phone orders, an owner or manager can add a
                pickup counter in Tables.
              </p>
            )}
            {diningTables.length > 0 && (
              <div className="grid flex-1 grid-cols-4 gap-2 @lg:grid-cols-6 @3xl:grid-cols-8 @5xl:grid-cols-3">
                {diningTables.map((t) => (
                  <PlaceButton
                    key={t.id}
                    selected={tableId === t.id}
                    onClick={() => chooseTable(t.id)}
                  >
                    {t.label.replace(/^Table\s+/i, "")}
                  </PlaceButton>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Menu */}
        <section
          aria-labelledby="pos-menu"
          className="@container/menu flex min-w-0 flex-col gap-3"
        >
          <h2 id="pos-menu" className="sr-only">
            Menu
          </h2>
          <div className="relative">
            <Search
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a dish"
              aria-label="Find a dish"
              className="h-11 pl-9"
            />
          </div>

          {!searching && (
            <div
              role="tablist"
              aria-label="Menu sections"
              className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
            >
              {menu.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="tab"
                  aria-selected={category?.id === c.id}
                  onClick={() => setCategoryId(c.id)}
                  className={cn(
                    "shrink-0 rounded-full border px-4 py-2 text-sm whitespace-nowrap transition-colors",
                    category?.id === c.id
                      ? "border-primary bg-primary text-primary-foreground"
                      : "hover:bg-muted",
                    !c.onNow && "opacity-60",
                  )}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}

          {!searching && category && !category.onNow && (
            <p className="text-muted-foreground text-sm">
              {category.name} isn&apos;t being served right now.
            </p>
          )}

          {shownDishes.length === 0 ? (
            <p className="text-muted-foreground text-sm">No dishes match.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 @md/menu:grid-cols-3 @2xl/menu:grid-cols-4">
              {shownDishes.map((dish) => {
                const servedNow = onNowByDish.get(dish.id) ?? true;
                const disabled = !dish.available || !servedNow;
                return (
                  <button
                    key={dish.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => tapDish(dish)}
                    className={cn(
                      "bg-card flex min-h-20 flex-col justify-between gap-2 rounded-xl border p-3 text-left transition-colors",
                      "hover:border-primary/60 active:bg-muted",
                      disabled && "cursor-not-allowed opacity-50",
                    )}
                  >
                    <span className="text-sm leading-snug font-medium">
                      {dish.name}
                    </span>
                    <span className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
                      <span className="tabular-nums">{money(dish.price)}</span>
                      {!dish.available ? (
                        <span>Sold out</span>
                      ) : !servedNow ? (
                        <span>Not now</span>
                      ) : dish.groups.length > 0 ? (
                        <span>Options</span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* Ticket */}
        <aside
          aria-labelledby="pos-ticket"
          className="bg-card flex flex-col gap-3 self-start rounded-xl border p-4 @2xl:sticky @2xl:top-4"
        >
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="pos-ticket" className="font-medium">
              {table
                ? isCounter
                  ? "Takeout / phone"
                  : table.label
                : "New order"}
            </h2>
            {totals.itemCount > 0 && (
              <span className="text-muted-foreground text-xs">
                {totals.itemCount} {totals.itemCount === 1 ? "item" : "items"}
              </span>
            )}
          </div>

          {sent && (
            <div
              role="status"
              className="border-success/30 bg-success/5 flex flex-col gap-3 rounded-lg border p-3"
            >
              <p className="flex items-center gap-2 text-sm font-medium">
                <CircleCheck
                  className="text-success size-5"
                  aria-hidden="true"
                />
                Order #{sent.order.orderNumber} sent to the kitchen
              </p>
              <p className="text-muted-foreground text-xs">
                {sent.where} · {money(sent.order.total)}
              </p>
              {sent.paidBy ? (
                <p className="text-success text-sm font-medium">
                  Paid · {sent.paidBy}
                </p>
              ) : sent.counter ? (
                <div className="flex flex-wrap gap-2">
                  {payments.card && (
                    <TapToPayDialog
                      restaurantId={restaurantId}
                      tableLabel={sent.where}
                      orders={[sent.order]}
                      currency={sent.order.currency}
                      tippingEnabled={payments.tipping}
                      onPaid={() => markPaid("card")}
                    />
                  )}
                  {payments.cash && (
                    <CashPaymentDialog
                      method="cash"
                      recordAction={recordCashPayment}
                      tableLabel={sent.where}
                      orders={[sent.order]}
                      currency={sent.order.currency}
                      tippingEnabled={payments.tipping}
                      onRecorded={() => markPaid("cash")}
                    />
                  )}
                  {payments.cardMachine && (
                    <CashPaymentDialog
                      method="card_terminal"
                      recordAction={recordCardTerminalPayment}
                      tableLabel={sent.where}
                      orders={[sent.order]}
                      currency={sent.order.currency}
                      tippingEnabled={payments.tipping}
                      onRecorded={() => markPaid("card machine")}
                    />
                  )}
                </div>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Add more for this table, or take payment in{" "}
                  <Link href="/dashboard/checkout" className="underline">
                    Settle up
                  </Link>
                  .
                </p>
              )}
              <Button type="button" variant="outline" onClick={nextOrder}>
                Next order
              </Button>
            </div>
          )}

          {isCounter && !(sent && lines.length === 0) && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pos-pickup-name">Name to call out</Label>
              <Input
                id="pos-pickup-name"
                value={pickupName}
                maxLength={60}
                placeholder="Walk-in"
                onChange={(e) => setPickupName(e.target.value)}
              />
            </div>
          )}

          {lines.length === 0 ? (
            !sent && (
              <p className="text-muted-foreground py-6 text-center text-sm">
                {table
                  ? "Tap dishes to add them."
                  : "Choose a table or takeout, then tap dishes."}
              </p>
            )
          ) : (
            <ul className="flex flex-col divide-y">
              {lines.map((line) => (
                <li key={line.key} className="flex items-start gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{line.name}</p>
                    {line.optionNames.length > 0 && (
                      <p className="text-muted-foreground text-xs">
                        {line.optionNames.join(", ")}
                      </p>
                    )}
                    {editingKey === line.key ? (
                      <Input
                        autoFocus
                        value={draftNote}
                        maxLength={200}
                        aria-label={`Note for ${line.name}`}
                        placeholder="No onions, extra spicy…"
                        className="mt-1 h-9"
                        onChange={(e) => setDraftNote(e.target.value)}
                        onBlur={saveNote}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveNote();
                          if (e.key === "Escape") setEditingKey(null);
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => startNote(line)}
                        className={cn(
                          "text-left text-xs",
                          line.notes
                            ? "italic"
                            : "text-muted-foreground underline-offset-2 hover:underline",
                        )}
                      >
                        {line.notes ? `“${line.notes}”` : "Add note"}
                      </button>
                    )}
                    <p className="text-muted-foreground text-xs tabular-nums">
                      {money(line.unitPrice * line.quantity)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-lg"
                      aria-label={`One fewer ${line.name}`}
                      onClick={() =>
                        setLines((prev) =>
                          setQuantity(prev, line.key, line.quantity - 1),
                        )
                      }
                    >
                      <Minus aria-hidden="true" />
                    </Button>
                    <span className="w-6 text-center text-sm tabular-nums">
                      {line.quantity}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-lg"
                      aria-label={`One more ${line.name}`}
                      onClick={() =>
                        setLines((prev) =>
                          setQuantity(prev, line.key, line.quantity + 1),
                        )
                      }
                    >
                      <Plus aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {lines.length > 0 &&
            (showNote ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pos-order-note">Order note</Label>
                <Textarea
                  id="pos-order-note"
                  value={note}
                  maxLength={500}
                  rows={2}
                  placeholder="Allergies, timing, anything for the kitchen"
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => setShowNote(true)}
              >
                <StickyNote aria-hidden="true" />
                Add order note
              </Button>
            ))}

          {lines.length > 0 && (
            <dl className="flex flex-col gap-1 border-t pt-3 text-sm">
              <Row label="Subtotal" value={money(totals.subtotal)} />
              {totals.tax > 0 && <Row label="Tax" value={money(totals.tax)} />}
              {totals.serviceCharge > 0 && (
                <Row
                  label="Service charge"
                  value={money(totals.serviceCharge)}
                />
              )}
              <Row label="Total" value={money(totals.total)} strong />
            </dl>
          )}

          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {lines.length > 0 && (
            <Button
              type="button"
              size="lg"
              disabled={!table || sending}
              onClick={send}
            >
              <Send aria-hidden="true" />
              {sending
                ? "Sending…"
                : table
                  ? `Send to kitchen · ${money(totals.total)}`
                  : "Choose a table first"}
            </Button>
          )}

          {lines.length > 0 && !sending && (
            <button
              type="button"
              className={cn(
                buttonVariants({ variant: "link", size: "sm" }),
                "text-muted-foreground self-center",
              )}
              onClick={() => {
                setLines([]);
                setNote("");
                setShowNote(false);
                setError(null);
              }}
            >
              Clear ticket
            </button>
          )}
        </aside>

        <DishOptionsDialog
          key={dialogKey}
          dish={optionsDish}
          currency={currency}
          onAdd={(line) => {
            addToTicket(line);
            setOptionsDish(null);
          }}
          onClose={() => setOptionsDish(null)}
        />
      </div>
    </div>
  );
}

function PlaceButton({
  selected,
  onClick,
  className,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "flex min-h-11 items-center justify-center rounded-lg border px-2 py-2 text-sm font-medium transition-colors",
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "bg-card hover:bg-muted",
        className,
      )}
    >
      {children}
    </button>
  );
}

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex justify-between gap-2",
        strong ? "text-base font-semibold" : "text-muted-foreground",
      )}
    >
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
