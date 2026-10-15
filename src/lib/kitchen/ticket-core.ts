import { resolveTimeZone } from "@/lib/reservations/timezone";

/**
 * Printed kitchen tickets, the part with no browser in it: the ticket as a
 * complete HTML page sized for a receipt printer, and which orders on a
 * refreshed board are new enough to print. No `server-only`, per the
 * extract-the-core convention; src/components/kitchen/ticket-printer.ts
 * does the printing.
 *
 * Printed through the device's own print system (window.print), which is
 * the one route that works with any printer a restaurant already has —
 * USB, network or Bluetooth — with no driver of ours. The page sets its
 * own paper width, so the OS dialog has nothing to guess.
 */

export type PaperWidth = "80mm" | "58mm";
export const PAPER_WIDTHS: readonly PaperWidth[] = ["80mm", "58mm"];

/** What a ticket needs from a kitchen order (KitchenOrder satisfies it). */
export interface TicketOrder {
  orderNumber: number;
  tableLabel: string;
  createdAt: string;
  customerNote: string | null;
  items: {
    quantity: number;
    itemName: string;
    modifiers: { optionName: string }[];
    spicePreference: string | null;
    notes: string | null;
  }[];
}

export interface TicketOptions {
  restaurantName: string;
  timeZone: string;
  paper: PaperWidth;
  /** A second copy printed by hand, marked so the line doesn't cook it twice. */
  reprint?: boolean;
}

const SPICE_LABELS: Record<string, string> = {
  none: "No spice",
  mild: "Mild",
  medium: "Medium",
  hot: "Hot",
  very_hot: "Very hot",
};

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function ticketTime(createdAt: string, timeZone: string): string {
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString("en-US", {
    timeZone: resolveTimeZone(timeZone),
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The whole ticket as one HTML document. Everything a diner typed (dish
 * notes, the order note) is escaped: it is printed, but it is also
 * rendered in a frame on the kitchen's own screen first.
 */
export function kitchenTicketHtml(
  order: TicketOrder,
  options: TicketOptions,
): string {
  const e = escapeHtml;
  // Printable width inside the paper's own unprintable edges.
  const width = options.paper === "58mm" ? "48mm" : "72mm";
  const size = options.paper === "58mm" ? 12 : 14;

  const lines = order.items
    .map((item) => {
      const extras = [
        ...item.modifiers.map((m) => `+ ${e(m.optionName)}`),
        item.spicePreference && SPICE_LABELS[item.spicePreference]
          ? `Spice: ${SPICE_LABELS[item.spicePreference]}`
          : null,
        item.notes ? `Note: ${e(item.notes)}` : null,
      ].filter(Boolean);
      return `<li><div class="dish"><span class="qty">${item.quantity}×</span> ${e(item.itemName)}</div>${
        extras.length > 0
          ? `<div class="extras">${extras.map((x) => `<div>${x}</div>`).join("")}</div>`
          : ""
      }</li>`;
    })
    .join("");

  const count = order.items.reduce((sum, i) => sum + i.quantity, 0);

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Order #${order.orderNumber}</title>
<style>
@page { size: ${options.paper} auto; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #000; }
body { width: ${width}; margin: 0 auto; padding: 3mm 0 6mm; font: ${size}px/1.3 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
.center { text-align: center; }
.small { font-size: ${size - 2}px; }
.big { font-size: ${size + 12}px; font-weight: 800; line-height: 1.1; }
.table { font-size: ${size + 6}px; font-weight: 700; }
.reprint { border: 2px solid #000; padding: 1mm; margin: 1mm 0; font-weight: 800; letter-spacing: 1px; }
hr { border: 0; border-top: 1px dashed #000; margin: 2mm 0; }
ul { list-style: none; margin: 0; padding: 0; }
li { margin: 0 0 2mm; }
.dish { font-weight: 700; font-size: ${size + 2}px; }
.qty { display: inline-block; min-width: 2.2em; }
.extras { padding-left: 2.2em; }
.note { border: 1px solid #000; padding: 1.5mm; margin-top: 2mm; }
</style></head>
<body>
<div class="center small">${e(options.restaurantName)}</div>
${options.reprint ? '<div class="center reprint">REPRINT</div>' : ""}
<div class="center big">#${order.orderNumber}</div>
<div class="center table">${e(order.tableLabel)}</div>
<div class="center small">${ticketTime(order.createdAt, options.timeZone)} · ${count} ${count === 1 ? "item" : "items"}</div>
<hr>
<ul>${lines}</ul>
${order.customerNote ? `<div class="note"><b>Order note:</b> ${e(order.customerNote)}</div>` : ""}
</body></html>`;
}

/**
 * Orders on a freshly loaded board that should print now: new ones (not
 * seen before) still waiting to be accepted. An order already on screen
 * when the device switched auto-print on is never printed by surprise.
 */
export function ordersToAutoPrint<T extends { id: string; status: string }>(
  fresh: readonly T[],
  knownIds: ReadonlySet<string>,
): T[] {
  return fresh.filter((o) => o.status === "pending" && !knownIds.has(o.id));
}

/** A sample ticket for the "Print a test ticket" button. */
export const TEST_TICKET: TicketOrder = {
  orderNumber: 0,
  tableLabel: "Test print",
  createdAt: new Date(0).toISOString(),
  customerNote: "If you can read this, the printer is set up.",
  items: [
    {
      quantity: 2,
      itemName: "Sample dish",
      modifiers: [{ optionName: "Extra sauce" }],
      spicePreference: "medium",
      notes: "No onions",
    },
  ],
};
