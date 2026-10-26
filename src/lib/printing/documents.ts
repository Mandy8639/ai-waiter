import { formatMoney } from "@/lib/orders/format";
import { SPICE_LABELS, ticketTime } from "@/lib/kitchen/ticket-core";
import type { DocLine, PrintDoc } from "./star-commands";

/**
 * What goes on paper: kitchen tickets, bills, receipts, a test page. Plain
 * data in, a printer-independent document out (star-commands.ts makes the
 * bytes). No `server-only`, per the extract-the-core convention.
 */

export interface PrintRestaurant {
  name: string;
  address: string | null;
  phone: string | null;
  timeZone: string;
}

export interface PrintOrderItem {
  quantity: number;
  itemName: string;
  lineTotal: number;
  stationId: string | null;
  modifiers: string[];
  spicePreference: string | null;
  notes: string | null;
}

export interface PrintOrder {
  orderNumber: number;
  createdAt: string;
  /** "Table 4", or "Pickup 6:30 PM · Priya". */
  placeLabel: string;
  customerNote: string | null;
  subtotal: number;
  tax: number;
  serviceCharge: number;
  total: number;
  currency: string;
  items: PrintOrderItem[];
}

export interface PrintPayment {
  method: "cash" | "card" | "card_terminal";
  /** A card taken in person on this app (Tap to Pay), not online. */
  cardPresent: boolean;
  amount: number;
  tip: number;
  currency: string;
  paidAt: string;
}

const text = (
  value: string,
  options: Omit<Extract<DocLine, { kind: "text" }>, "kind" | "text"> = {},
): DocLine => ({ kind: "text", text: value, ...options });

/**
 * A kitchen ticket: big order number, where it goes, then each dish with
 * its add-ons, spice and note. A printer for one station gets only that
 * station's dishes, and nothing at all (null) if the order has none.
 */
export function kitchenTicketDoc(
  order: PrintOrder,
  options: {
    restaurant: PrintRestaurant;
    stationId?: string | null;
    stationName?: string | null;
    reprint?: boolean;
  },
): PrintDoc | null {
  const items = options.stationId
    ? order.items.filter((i) => i.stationId === options.stationId)
    : order.items;
  if (items.length === 0) return null;

  const lines: DocLine[] = [];
  if (options.reprint)
    lines.push(text("** REPRINT **", { align: "center", bold: true }));
  lines.push(
    text(`#${order.orderNumber}`, { align: "center", bold: true, size: 2 }),
  );
  lines.push(text(order.placeLabel, { align: "center", bold: true }));
  lines.push(
    text(
      [
        ticketTime(order.createdAt, options.restaurant.timeZone),
        options.stationName,
      ]
        .filter(Boolean)
        .join(" · "),
      { align: "center" },
    ),
  );
  lines.push({ kind: "rule" });

  for (const item of items) {
    lines.push(text(`${item.quantity} x ${item.itemName}`, { bold: true }));
    for (const modifier of item.modifiers) lines.push(text(`   + ${modifier}`));
    if (item.spicePreference && SPICE_LABELS[item.spicePreference]) {
      lines.push(text(`   * ${SPICE_LABELS[item.spicePreference]}`));
    }
    if (item.notes) lines.push(text(`   ! ${item.notes}`, { bold: true }));
  }

  if (order.customerNote) {
    lines.push({ kind: "rule" });
    lines.push(text(`Note: ${order.customerNote}`, { bold: true }));
  }
  return { lines, cut: true };
}

function header(restaurant: PrintRestaurant): DocLine[] {
  const lines: DocLine[] = [
    text(restaurant.name, { align: "center", bold: true, size: 2 }),
  ];
  if (restaurant.address)
    lines.push(text(restaurant.address, { align: "center" }));
  if (restaurant.phone) lines.push(text(restaurant.phone, { align: "center" }));
  lines.push({ kind: "feed" });
  return lines;
}

/** Every dish across the orders, then the totals. */
function itemsAndTotals(orders: PrintOrder[]): DocLine[] {
  const currency = orders[0]?.currency ?? "USD";
  const money = (v: number) => formatMoney(v, currency);
  const lines: DocLine[] = [];
  for (const order of orders) {
    for (const item of order.items) {
      lines.push({
        kind: "pair",
        left: `${item.quantity} x ${item.itemName}`,
        right: money(item.lineTotal),
      });
      for (const modifier of item.modifiers) lines.push(text(`   ${modifier}`));
    }
  }
  const sum = (pick: (o: PrintOrder) => number) =>
    Math.round(orders.reduce((s, o) => s + pick(o), 0) * 100) / 100;
  lines.push({ kind: "rule" });
  lines.push({
    kind: "pair",
    left: "Subtotal",
    right: money(sum((o) => o.subtotal)),
  });
  const tax = sum((o) => o.tax);
  if (tax > 0) lines.push({ kind: "pair", left: "Tax", right: money(tax) });
  const service = sum((o) => o.serviceCharge);
  if (service > 0)
    lines.push({ kind: "pair", left: "Service charge", right: money(service) });
  lines.push({
    kind: "pair",
    left: "Total",
    right: money(sum((o) => o.total)),
    bold: true,
  });
  return lines;
}

function orderNumbers(orders: PrintOrder[]): string {
  return orders.map((o) => `#${o.orderNumber}`).join(", ");
}

/** The bill a table asks for: what they owe, before paying. */
export function billDoc(
  orders: PrintOrder[],
  options: { restaurant: PrintRestaurant; now: Date },
): PrintDoc {
  const { restaurant } = options;
  return {
    lines: [
      ...header(restaurant),
      text(orders[0]?.placeLabel ?? "", { align: "center", bold: true }),
      text(
        `${orderNumbers(orders)} · ${ticketTime(options.now.toISOString(), restaurant.timeZone)}`,
        { align: "center" },
      ),
      { kind: "rule" },
      ...itemsAndTotals(orders),
      { kind: "feed" },
      text("Thank you!", { align: "center" }),
    ],
    cut: true,
  };
}

const METHOD_LABEL: Record<PrintPayment["method"], string> = {
  cash: "Cash",
  card: "Card",
  card_terminal: "Card",
};

/** A receipt: the bill, then how it was paid, with the tip. */
export function receiptDoc(
  orders: PrintOrder[],
  payment: PrintPayment,
  options: { restaurant: PrintRestaurant; openDrawer?: boolean },
): PrintDoc {
  const { restaurant } = options;
  const money = (v: number) => formatMoney(v, payment.currency);
  const paidAt = new Date(payment.paidAt);
  const date = Number.isNaN(paidAt.getTime())
    ? ""
    : paidAt.toLocaleDateString("en-US", {
        timeZone: restaurant.timeZone,
        month: "short",
        day: "numeric",
        year: "numeric",
      });
  const lines: DocLine[] = [
    ...header(restaurant),
    text("RECEIPT", { align: "center", bold: true }),
    text(orders[0]?.placeLabel ?? "", { align: "center" }),
    text(
      `${orderNumbers(orders)} · ${date} ${ticketTime(payment.paidAt, restaurant.timeZone)}`.trim(),
      { align: "center" },
    ),
    { kind: "rule" },
    ...itemsAndTotals(orders),
  ];
  if (payment.tip > 0)
    lines.push({ kind: "pair", left: "Tip", right: money(payment.tip) });
  lines.push({
    kind: "pair",
    left: `Paid · ${METHOD_LABEL[payment.method]}`,
    right: money(payment.amount + payment.tip),
    bold: true,
  });
  lines.push({ kind: "feed" });
  lines.push(text("Thank you!", { align: "center" }));
  return { lines, openDrawer: options.openDrawer, cut: true };
}

/** Opens the cash drawer and prints nothing. */
export function drawerDoc(): PrintDoc {
  return { lines: [], openDrawer: true, cut: false };
}

export function testDoc(options: {
  restaurant: PrintRestaurant;
  printerName: string;
  role: "kitchen" | "receipt";
  now: Date;
}): PrintDoc {
  return {
    lines: [
      text("Tableside", { align: "center", bold: true, size: 2 }),
      text("Printer test", { align: "center", bold: true }),
      { kind: "rule" },
      { kind: "pair", left: "Restaurant", right: options.restaurant.name },
      { kind: "pair", left: "Printer", right: options.printerName },
      {
        kind: "pair",
        left: "Prints",
        right:
          options.role === "kitchen" ? "Kitchen tickets" : "Bills & receipts",
      },
      {
        kind: "pair",
        left: "Time",
        right: ticketTime(
          options.now.toISOString(),
          options.restaurant.timeZone,
        ),
      },
      { kind: "rule" },
      text("If you can read this, printing works.", { align: "center" }),
    ],
    cut: true,
  };
}
